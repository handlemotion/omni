//! One recording in progress: capture, side by side, mic intervals, Opus, spool. It runs on its
//! own thread; the shell (or `omni-record`) pauses, resumes and stops it, and hears its state.

use std::fs::File;
use std::io;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use omni_sync_types::desktop_recorder::DesktopRecording;

use crate::capture::{self, CaptureError, Chunk, Source};
use crate::detect::{MicDetector, level_db};
use crate::encode::{Frame, OggOpusWriter};
use crate::mix::Interleaver;
use crate::spool::{NewRecording, Spool, State};

const TICK: Duration = Duration::from_millis(20);
const NOTIFY_EVERY: Duration = Duration::from_millis(250);
/// How often the file is forced to the disk, against a power cut (a crash loses nothing the
/// kernel already has).
const SYNC_EVERY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wanted {
    Record,
    Pause,
    Stop,
}

pub type OnChange = Box<dyn Fn(DesktopRecording) + Send>;

pub struct Recorder {
    wanted: Arc<Mutex<Wanted>>,
    latest: Arc<Mutex<DesktopRecording>>,
    thread: Option<JoinHandle<io::Result<DesktopRecording>>>,
}

#[derive(Debug)]
pub enum StartError {
    /// The meeting already has a spool here (a recording, or one still uploading).
    AlreadySpooled,
    Capture(CaptureError),
    Io(io::Error),
}

impl From<io::Error> for StartError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::AlreadyExists {
            Self::AlreadySpooled
        } else {
            Self::Io(error)
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Recorder {
    /// Starts capturing into a new spool under `root`. Nothing is left on disk if capture
    /// cannot start.
    pub fn start(
        root: &Path,
        new: NewRecording,
        source: Source,
        on_change: OnChange,
    ) -> Result<Self, StartError> {
        let spool = Spool::create(root, new)?;
        let file = File::create(spool.audio_path())?;
        let writer = OggOpusWriter::new(file, rand_serial())?;
        let (tx, rx) = mpsc::channel();
        let capture = match capture::start(source, tx) {
            Ok(capture) => capture,
            Err(error) => {
                spool.remove()?;
                return Err(StartError::Capture(error));
            }
        };
        let wanted = Arc::new(Mutex::new(Wanted::Record));
        let latest = Arc::new(Mutex::new(spool.snapshot(-120.0)));
        let run = Run {
            spool,
            writer,
            wanted: wanted.clone(),
            latest: latest.clone(),
            on_change,
        };
        let thread = thread::Builder::new()
            .name("omni-recorder".into())
            .spawn(move || run.run(rx, capture))?;
        Ok(Self {
            wanted,
            latest,
            thread: Some(thread),
        })
    }

    pub fn pause(&self) {
        let mut wanted = lock(&self.wanted);
        if *wanted == Wanted::Record {
            *wanted = Wanted::Pause;
        }
    }

    pub fn resume(&self) {
        let mut wanted = lock(&self.wanted);
        if *wanted == Wanted::Pause {
            *wanted = Wanted::Record;
        }
    }

    pub fn snapshot(&self) -> DesktopRecording {
        lock(&self.latest).clone()
    }

    /// True once capture ended by itself (a device went away); `stop` then answers at once.
    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }

    /// Stops, closes the file and answers the stopped recording, ready to upload.
    pub fn stop(mut self) -> io::Result<DesktopRecording> {
        *lock(&self.wanted) = Wanted::Stop;
        let thread = self
            .thread
            .take()
            .ok_or_else(|| io::Error::other("already stopped"))?;
        thread
            .join()
            .map_err(|_| io::Error::other("the recorder thread panicked"))?
    }
}

impl Drop for Recorder {
    /// Quitting while recording closes the file properly rather than leaving it to recovery.
    fn drop(&mut self) {
        *lock(&self.wanted) = Wanted::Stop;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn rand_serial() -> u32 {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

struct Run {
    spool: Spool,
    writer: OggOpusWriter<File>,
    wanted: Arc<Mutex<Wanted>>,
    latest: Arc<Mutex<DesktopRecording>>,
    on_change: OnChange,
}

impl Run {
    fn run(
        mut self,
        rx: mpsc::Receiver<Chunk>,
        capture: Box<dyn capture::Capture>,
    ) -> io::Result<DesktopRecording> {
        let mut mix = Interleaver::default();
        let mut detector = MicDetector::default();
        let mut mic_db = -120.0_f32;
        let mut paused_at: Option<Instant> = None;
        let mut notified = Instant::now();
        let mut synced = Instant::now();
        loop {
            match rx.recv_timeout(TICK) {
                Ok(Chunk::Mic(samples)) if paused_at.is_none() => {
                    mic_db = level_db(samples.iter().copied());
                    mix.push_mic(&samples);
                }
                Ok(Chunk::System(samples)) if paused_at.is_none() => mix.push_system(&samples),
                Ok(Chunk::Ended(_)) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(_) | Err(RecvTimeoutError::Timeout) => {}
            }
            let wanted = *lock(&self.wanted);
            match (wanted, paused_at) {
                (Wanted::Stop, _) => break,
                (Wanted::Pause, None) => {
                    self.close_span(&mut detector)?;
                    mix.clear();
                    mic_db = -120.0;
                    paused_at = Some(Instant::now());
                    self.set_state(State::Paused)?;
                }
                (Wanted::Record, Some(since)) => {
                    let dropped = since.elapsed().as_millis() as u64;
                    if dropped > 0 {
                        self.spool
                            .manifest
                            .cuts
                            .push((self.writer.duration_ms(), dropped));
                    }
                    paused_at = None;
                    self.set_state(State::Recording)?;
                }
                _ => {}
            }
            while let Some(frame) = mix.frame() {
                self.encode(&frame, &mut detector)?;
            }
            if synced.elapsed() >= SYNC_EVERY {
                self.writer.get_mut().sync_data()?;
                synced = Instant::now();
            }
            if notified.elapsed() >= NOTIFY_EVERY {
                self.notify(f64::from(mic_db));
                notified = Instant::now();
            }
        }
        drop(capture);
        while let Some(frame) = mix.frame() {
            self.encode(&frame, &mut detector)?;
        }
        self.close_span(&mut detector)?;
        let duration_ms = self.writer.duration_ms();
        let file = self.writer.finish()?;
        file.sync_all()?;
        self.spool.manifest.duration_ms = duration_ms;
        self.spool.manifest.state = State::Stopped;
        self.spool.save()?;
        let stopped = self.spool.snapshot(-120.0);
        *lock(&self.latest) = stopped.clone();
        (self.on_change)(stopped.clone());
        Ok(stopped)
    }

    fn encode(&mut self, frame: &Frame, detector: &mut MicDetector) -> io::Result<()> {
        let mic = level_db(frame.iter().step_by(2).copied());
        let system = level_db(frame.iter().skip(1).step_by(2).copied());
        let was_open = detector.open_since().is_some();
        if let Some(span) = detector.push(mic, system) {
            self.spool.append_span(span)?;
        }
        if let (false, Some(start)) = (was_open, detector.open_since()) {
            self.spool.open_span(start)?;
        }
        self.writer.push(frame)
    }

    fn close_span(&mut self, detector: &mut MicDetector) -> io::Result<()> {
        match detector.close() {
            Some(span) => self.spool.append_span(span),
            None => Ok(()),
        }
    }

    fn set_state(&mut self, state: State) -> io::Result<()> {
        self.spool.manifest.state = state;
        self.spool.manifest.duration_ms = self.writer.duration_ms();
        self.spool.save()?;
        self.notify(-120.0);
        Ok(())
    }

    fn notify(&mut self, mic_db: f64) {
        self.spool.manifest.duration_ms = self.writer.duration_ms();
        let now = self.spool.snapshot(mic_db);
        *lock(&self.latest) = now.clone();
        (self.on_change)(now);
    }
}
