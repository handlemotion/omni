//! macOS: `omni-capture`, the Swift helper in `Contents/MacOS/` (`recorder/macos`), does the
//! capture, because Core Audio's process taps and ScreenCaptureKit are Objective-C APIs this
//! crate would need `unsafe` for. It writes the `pipe.rs` format on stdout and reads pause,
//! resume and stop on stdin; killing it stops it at once.
//!
//! Its exit code says why it could not start: 2, no microphone permission; 3, no permission to
//! capture the computer's sound (audio capture on 14.4+, screen recording before).

use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::Sender;
use std::thread;
use std::time::{Duration, Instant};

use super::pipe::{PAUSE, READY, RESUME, read_chunk};
use super::{Capture, CaptureError, Chunk};

pub struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
}

/// How long the helper may take to write the video's last fragment and exit.
const FINISH_WITHIN: Duration = Duration::from_secs(3);

impl Helper {
    fn tell(&mut self, command: u8) {
        if let Some(stdin) = self.stdin.as_mut() {
            let _ = stdin.write_all(&[command]).and_then(|()| stdin.flush());
        }
    }
}

impl Capture for Helper {
    fn pause(&mut self) {
        self.tell(PAUSE);
    }

    fn resume(&mut self) {
        self.tell(RESUME);
    }

    fn finish(&mut self) -> bool {
        // Its stdin ending is the helper's stop.
        drop(self.stdin.take());
        let until = Instant::now() + FINISH_WITHIN;
        while Instant::now() < until {
            if matches!(self.child.try_wait(), Ok(Some(_)) | Err(_)) {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        true
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn failed(child: &mut Child) -> CaptureError {
    let mut message = String::new();
    if let Some(stderr) = child.stderr.as_mut() {
        let _ = stderr.read_to_string(&mut message);
    }
    match child.wait().ok().and_then(|status| status.code()) {
        Some(2) => CaptureError::PermissionDenied(
            "Wok is not allowed to use the microphone (System Settings → Privacy & Security)"
                .into(),
        ),
        Some(3) => CaptureError::PermissionDenied(
            "Wok is not allowed to record this Mac's sound (System Settings → Privacy & Security)"
                .into(),
        ),
        _ => CaptureError::Failed(message.trim().to_owned()),
    }
}

pub fn start(tx: Sender<Chunk>) -> Result<Helper, CaptureError> {
    let helper = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join("omni-capture")))
        .filter(|path| path.exists())
        .ok_or(CaptureError::Unavailable)?;
    let mut child = Command::new(helper)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CaptureError::Failed(e.to_string()))?;
    let stdin = child.stdin.take();
    let Some(stdout) = child.stdout.take() else {
        return Err(CaptureError::Failed(
            "the capture helper has no output".into(),
        ));
    };
    let mut reader = BufReader::new(stdout);
    // Waits as long as the person takes to answer the permission prompts.
    let mut ready = [0_u8; 1];
    if reader.read_exact(&mut ready).is_err() || ready[0] != READY {
        return Err(failed(&mut child));
    }
    thread::spawn(move || {
        loop {
            match read_chunk(&mut reader) {
                Ok(Some(chunk)) => {
                    if tx.send(chunk).is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    let _ = tx.send(Chunk::Ended("the capture helper stopped".into()));
                    return;
                }
                Err(error) => {
                    let _ = tx.send(Chunk::Ended(error.to_string()));
                    return;
                }
            }
        }
    });
    Ok(Helper { child, stdin })
}
