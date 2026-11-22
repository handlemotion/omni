//! When the person at this computer is speaking: the microphone carries speech and the
//! computer's sound does not (docs/spec/meetings.md, "Who is speaking on this computer"). A plain
//! energy detector per 20 ms frame, with a hangover so pauses between words stay in one span.

use serde::{Deserialize, Serialize};

/// Below this a channel is silent (dBFS, RMS of a frame).
const SPEECH_DB: f32 = -45.0;
/// Frames of quiet that end a span: 300 ms.
const HANGOVER: u32 = 15;
/// Spans shorter than this are clicks and coughs: 200 ms.
const MIN_SPAN_MS: u64 = 200;
const FRAME_MS: u64 = 20;

/// An interval of the recording, in milliseconds of audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// RMS level of mono samples in dBFS; -120 for silence.
pub fn level_db(samples: impl Iterator<Item = f32>) -> f32 {
    let (sum, n) = samples.fold((0.0_f64, 0_u32), |(sum, n), s| {
        (sum + f64::from(s) * f64::from(s), n + 1)
    });
    if n == 0 || sum == 0.0 {
        return -120.0;
    }
    let rms = (sum / f64::from(n)).sqrt();
    (20.0 * rms.log10()).max(-120.0) as f32
}

#[derive(Default)]
pub struct MicDetector {
    frame: u64,
    open: Option<u64>,
    last_speech_end: u64,
    quiet: u32,
}

impl MicDetector {
    /// Feeds one 20 ms frame's levels. Answers a span when one just closed.
    pub fn push(&mut self, mic_db: f32, system_db: f32) -> Option<Span> {
        let start = self.frame * FRAME_MS;
        self.frame += 1;
        let speech = mic_db > SPEECH_DB && system_db <= SPEECH_DB;
        if speech {
            self.open.get_or_insert(start);
            self.last_speech_end = start + FRAME_MS;
            self.quiet = 0;
            return None;
        }
        if self.open.is_some() {
            self.quiet += 1;
            if self.quiet >= HANGOVER {
                return self.close();
            }
        }
        None
    }

    /// Where the span being spoken now began, if one is open.
    pub fn open_since(&self) -> Option<u64> {
        self.open
    }

    /// Closes the open span, as when the recording stops or pauses.
    pub fn close(&mut self) -> Option<Span> {
        let start_ms = self.open.take()?;
        self.quiet = 0;
        let span = Span {
            start_ms,
            end_ms: self.last_speech_end,
        };
        (span.end_ms - span.start_ms >= MIN_SPAN_MS).then_some(span)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(frames: &[(f32, f32)]) -> Vec<Span> {
        let mut detector = MicDetector::default();
        let mut spans: Vec<Span> = frames
            .iter()
            .filter_map(|&(mic, system)| detector.push(mic, system))
            .collect();
        spans.extend(detector.close());
        spans
    }

    // Bug: the recorder is named from these spans; if the call's sound leaking into the mic
    // counted, the recorder would be credited with the other person's words.
    #[test]
    fn mic_speech_over_call_sound_is_not_the_recorder() {
        let loud = -20.0;
        let quiet = -80.0;
        let mut frames = vec![(loud, quiet); 50];
        frames.extend(vec![(loud, loud); 50]);
        frames.extend(vec![(quiet, quiet); 20]);
        assert_eq!(
            run(&frames),
            vec![Span {
                start_ms: 0,
                end_ms: 1000
            }]
        );
    }

    // Bug: closing a span at every breath would split a sentence into dozens of fragments.
    #[test]
    fn short_pauses_stay_in_one_span() {
        let mut frames = vec![(-20.0, -80.0); 20];
        frames.extend(vec![(-80.0, -80.0); 10]);
        frames.extend(vec![(-20.0, -80.0); 20]);
        assert_eq!(
            run(&frames),
            vec![Span {
                start_ms: 0,
                end_ms: 1000
            }]
        );
    }

    // Bug: a cough would count as speaking time.
    #[test]
    fn clicks_are_not_spans() {
        let mut frames = vec![(-20.0, -80.0); 3];
        frames.extend(vec![(-80.0, -80.0); 30]);
        assert_eq!(run(&frames), vec![]);
    }

    #[test]
    fn level_of_silence_and_full_scale() {
        assert_eq!(level_db([0.0; 10].into_iter()), -120.0);
        assert!((level_db([1.0, -1.0].into_iter())).abs() < 0.01);
    }
}
