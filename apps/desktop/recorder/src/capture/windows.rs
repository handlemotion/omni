//! Windows: WASAPI in shared mode, one thread per stream, both asked for 48 kHz mono float
//! (`autoconvert` lets the audio engine convert from the device's own format).
//!
//! - The computer's sound: loopback on the default output device.
//! - The microphone: the default communications device, in the communications category, with
//!   acoustic echo cancellation pointed at the default output where the device supports it
//!   (Windows 11), so the call coming out of speakers stays off the mic channel.
//!
//! Loopback sends nothing while nothing plays, so a wait that times out is not an error.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::thread;

use wasapi::{
    AudioClientProperties, DeviceEnumerator, Direction, Role, SampleType, StreamCategory,
    StreamMode, WaveFormat, initialize_mta,
};

use super::{Capture, CaptureError, Chunk};

const WAIT_MS: u32 = 200;

pub struct Wasapi {
    running: Arc<AtomicBool>,
}

impl Capture for Wasapi {}

impl Drop for Wasapi {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy)]
enum Stream {
    Mic,
    System,
}

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn samples(bytes: &mut VecDeque<u8>) -> Vec<f32> {
    let whole = bytes.len() / 4 * 4;
    let raw: Vec<u8> = bytes.drain(..whole).collect();
    raw.chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

fn run(
    stream: Stream,
    tx: &Sender<Chunk>,
    running: &AtomicBool,
    ready: &Sender<Result<(), String>>,
) -> Res<()> {
    let _ = initialize_mta();
    let enumerator = DeviceEnumerator::new()?;
    let device = match stream {
        Stream::Mic => {
            enumerator.get_default_device_for_role(Direction::Capture, Role::Communications)?
        }
        Stream::System => enumerator.get_default_device(Direction::Render)?,
    };
    let mut client = device.get_iaudioclient()?;
    if let Stream::Mic = stream {
        let properties = AudioClientProperties::new().set_category(StreamCategory::Communications);
        client.set_properties(properties)?;
    }
    let format = WaveFormat::new(32, 32, SampleType::Float, 48_000, 1, None);
    let (_, min_period) = client.get_device_period()?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    client.initialize_client(&format, Direction::Capture, mode, None)?;
    if let Stream::Mic = stream
        && client.is_aec_supported().unwrap_or(false)
    {
        let output = enumerator.get_default_device(Direction::Render)?;
        client
            .get_aec_control()?
            .set_echo_cancellation_render_endpoint(Some(output.get_id()?))?;
    }
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;
    let _ = ready.send(Ok(()));
    let mut queue = VecDeque::new();
    while running.load(Ordering::SeqCst) {
        if event.wait_for_event(WAIT_MS).is_err() {
            continue;
        }
        capture.read_from_device_to_deque(&mut queue)?;
        let chunk = samples(&mut queue);
        let sent = match stream {
            Stream::Mic => tx.send(Chunk::Mic(chunk)),
            Stream::System => tx.send(Chunk::System(chunk)),
        };
        if sent.is_err() {
            break;
        }
    }
    client.stop_stream()?;
    Ok(())
}

pub fn start(tx: Sender<Chunk>) -> Result<Wasapi, CaptureError> {
    let running = Arc::new(AtomicBool::new(true));
    for stream in [Stream::Mic, Stream::System] {
        let (ready_tx, ready_rx) = mpsc::channel();
        let (tx, alive) = (tx.clone(), running.clone());
        thread::spawn(move || {
            if let Err(error) = run(stream, &tx, &alive, &ready_tx) {
                let message = error.to_string();
                let _ = ready_tx.send(Err(message.clone()));
                let _ = tx.send(Chunk::Ended(message));
            }
        });
        match ready_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(message)) => {
                running.store(false, Ordering::SeqCst);
                // E_ACCESSDENIED: Settings → Privacy → Microphone is off for desktop apps.
                return Err(if message.contains("0x80070005") {
                    CaptureError::PermissionDenied(
                        "microphone access is off in Windows' privacy settings".into(),
                    )
                } else {
                    CaptureError::Failed(message)
                });
            }
            Err(_) => {
                running.store(false, Ordering::SeqCst);
                return Err(CaptureError::Failed("the audio thread ended".into()));
            }
        }
    }
    Ok(Wasapi { running })
}
