//! A source with a known answer: 20 ms chunks in real time, the mic speaking for 1.5 s, then the
//! call's sound for 1 s, over and over. The mic intervals it should give are
//! `[2500k, 2500k + 1500]` milliseconds.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::thread;
use std::time::{Duration, Instant};

use super::{Capture, Chunk};

const CHUNK: usize = 960;
const CYCLE_MS: u64 = 2500;
const MIC_MS: u64 = 1500;

pub struct Synthetic {
    running: Arc<AtomicBool>,
}

impl Capture for Synthetic {}

impl Drop for Synthetic {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

fn tone(at: u64, hz: f32, on: bool) -> Vec<f32> {
    (0..CHUNK as u64)
        .map(|i| {
            if !on {
                return 0.0;
            }
            let t = (at + i) as f32 / 48_000.0;
            (t * hz * std::f32::consts::TAU).sin() * 0.25
        })
        .collect()
}

pub fn start(tx: Sender<Chunk>) -> Synthetic {
    let running = Arc::new(AtomicBool::new(true));
    let alive = running.clone();
    thread::spawn(move || {
        let begun = Instant::now();
        let mut sample = 0_u64;
        while alive.load(Ordering::SeqCst) {
            let ms = sample / 48;
            let mic_on = ms % CYCLE_MS < MIC_MS;
            let sent = tx.send(Chunk::Mic(tone(sample, 220.0, mic_on))).is_ok()
                && tx.send(Chunk::System(tone(sample, 330.0, !mic_on))).is_ok();
            if !sent {
                return;
            }
            sample += CHUNK as u64;
            let due = Duration::from_millis(sample / 48);
            if let Some(wait) = due.checked_sub(begun.elapsed()) {
                thread::sleep(wait);
            }
        }
    });
    Synthetic { running }
}
