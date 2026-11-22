//! Where the two streams come from. Each source sends mono 48 kHz samples tagged with their
//! channel; the recorder puts them side by side (`mix.rs`).
//!
//! - macOS: `omni-capture`, a Swift helper beside the app's executable (`recorder/macos`), which
//!   reads the system output through a Core Audio process tap (14.4+) or ScreenCaptureKit
//!   (13 to 14.3), and the microphone with voice processing on.
//! - Windows: WASAPI loopback on the default output, and the default microphone in the
//!   communications category, which turns on the system's echo cancellation where the driver
//!   offers it.
//! - Anywhere: `synthetic`, a known pattern of tones, for `omni-record` and the tests.

use std::sync::mpsc::Sender;

#[cfg(target_os = "macos")]
mod macos;
pub mod pipe;
mod synthetic;
#[cfg(target_os = "windows")]
mod windows;

/// What a source sends the recorder.
#[derive(Debug)]
pub enum Chunk {
    Mic(Vec<f32>),
    System(Vec<f32>),
    /// The source stopped by itself (a device went away, permission was revoked).
    Ended(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// This computer's microphone and sound.
    Device,
    /// Tones: the mic speaks for 1.5 s, then the call answers for 1 s, and again.
    Synthetic,
}

#[derive(Debug)]
pub enum CaptureError {
    /// No recorder on this platform (Linux).
    Unavailable,
    /// The person has not allowed microphone or audio capture; the message says which.
    PermissionDenied(String),
    Failed(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => write!(f, "recording is not available on this computer"),
            Self::PermissionDenied(what) | Self::Failed(what) => write!(f, "{what}"),
        }
    }
}

/// A running source; dropping it stops capture.
pub trait Capture: Send {}

pub fn start(source: Source, tx: Sender<Chunk>) -> Result<Box<dyn Capture>, CaptureError> {
    match source {
        Source::Synthetic => Ok(Box::new(synthetic::start(tx))),
        Source::Device => device(tx),
    }
}

#[cfg(target_os = "macos")]
fn device(tx: Sender<Chunk>) -> Result<Box<dyn Capture>, CaptureError> {
    macos::start(tx).map(|c| Box::new(c) as Box<dyn Capture>)
}

#[cfg(target_os = "windows")]
fn device(tx: Sender<Chunk>) -> Result<Box<dyn Capture>, CaptureError> {
    windows::start(tx).map(|c| Box::new(c) as Box<dyn Capture>)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn device(_tx: Sender<Chunk>) -> Result<Box<dyn Capture>, CaptureError> {
    Err(CaptureError::Unavailable)
}
