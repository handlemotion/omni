//! Puts the two capture streams side by side. They run on different clocks and the computer's
//! sound may send nothing at all while nothing plays (WASAPI loopback does exactly that), so the
//! microphone sets the pace: each 20 ms of mic takes the same length of system sound if it has
//! arrived, else silence. System sound that runs ahead is dropped past a small backlog so the
//! channels never drift apart.

use std::collections::VecDeque;

use crate::encode::{FRAME, Frame, RATE};

/// The most system sound kept waiting for the mic: 200 ms.
const MAX_BACKLOG: usize = RATE as usize / 5;

#[derive(Default)]
pub struct Interleaver {
    mic: VecDeque<f32>,
    system: VecDeque<f32>,
}

impl Interleaver {
    pub fn push_mic(&mut self, samples: &[f32]) {
        self.mic.extend(samples);
    }

    pub fn push_system(&mut self, samples: &[f32]) {
        self.system.extend(samples);
        let over = self.system.len().saturating_sub(MAX_BACKLOG);
        self.system.drain(..over);
    }

    /// The next stereo frame, once the mic has 20 ms of it.
    pub fn frame(&mut self) -> Option<Frame> {
        if self.mic.len() < FRAME {
            return None;
        }
        let mut frame = [0.0; FRAME * 2];
        for pair in frame.chunks_exact_mut(2) {
            pair[0] = self.mic.pop_front().unwrap_or(0.0);
            pair[1] = self.system.pop_front().unwrap_or(0.0);
        }
        Some(frame)
    }

    /// Forgets what is waiting, as on pause: nothing said while paused is kept.
    pub fn clear(&mut self) {
        self.mic.clear();
        self.system.clear();
    }
}

/// Converts mono samples at `from` Hz to 48 kHz by linear interpolation, carrying the position
/// across calls. Enough for speech; most devices already run at 48 kHz and skip it.
pub struct Resampler {
    step: f64,
    position: f64,
    last: f32,
}

impl Resampler {
    pub fn new(from: u32) -> Self {
        Self {
            step: f64::from(from) / f64::from(RATE),
            position: 0.0,
            last: 0.0,
        }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if (self.step - 1.0).abs() < f64::EPSILON {
            return input.to_vec();
        }
        let mut out = Vec::with_capacity((input.len() as f64 / self.step) as usize + 1);
        // Positions are relative to `input[0]`; -1 is the last sample of the previous call.
        while self.position < input.len() as f64 - 1.0 {
            let i = self.position.floor();
            let frac = (self.position - i) as f32;
            let a = if i < 0.0 {
                self.last
            } else {
                input[i as usize]
            };
            let b = input[(i + 1.0) as usize];
            out.push(a + (b - a) * frac);
            self.position += self.step;
        }
        self.position -= input.len() as f64;
        self.last = input.last().copied().unwrap_or(self.last);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bug: waiting for system sound that never comes (loopback is silent while nothing plays)
    // would stall the recording in a room meeting.
    #[test]
    fn the_mic_sets_the_pace_and_missing_system_sound_is_silence() {
        let mut mix = Interleaver::default();
        mix.push_mic(&[0.5; FRAME]);
        let frame = mix.frame().unwrap();
        assert!(frame.chunks_exact(2).all(|p| p == [0.5, 0.0]));
        assert!(mix.frame().is_none());
    }

    // Bug: system sound arriving faster than the mic would pile up and slide the right channel
    // later and later against the left.
    #[test]
    fn system_sound_ahead_of_the_mic_is_capped() {
        let mut mix = Interleaver::default();
        mix.push_system(&vec![0.1; RATE as usize]);
        assert_eq!(mix.system.len(), MAX_BACKLOG);
    }

    // Bug: a 44.1 kHz device recorded as 48 kHz plays fast and every time in the transcript is off.
    #[test]
    fn resampling_keeps_the_duration() {
        let mut resampler = Resampler::new(44_100);
        let mut total = 0;
        for _ in 0..100 {
            total += resampler.process(&[0.2; 441]).len();
        }
        assert!((total as i64 - 48_000).abs() <= 2, "{total}");
    }
}
