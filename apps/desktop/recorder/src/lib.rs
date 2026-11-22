//! The meeting recorder (docs/spec/meetings.md, "Capture"): two channels (mic left, the
//! computer's sound right), Opus in Ogg at 32 kbit/s, written to a spool that a crash cannot
//! lose, with the intervals when the person at this computer spoke.
//!
//! Capture and the spool live here; the page uploads the spool through Drive and tells the
//! server (`finishRecording` in `@omni/client`), because the page holds the session.

pub mod capture;
pub mod detect;
pub mod encode;
pub mod mix;
pub mod ogg;
pub mod recorder;
pub mod spool;

use std::io;
use std::path::Path;

pub use recorder::{Recorder, StartError};
pub use spool::{NewRecording, Spool};

/// Stops every recording under `root` that a crash or a quit left open, except `live` (the one
/// capturing now), and answers them all, oldest first. Safe to run any number of times.
pub fn recover_left(root: &Path, live: Option<&str>) -> io::Result<Vec<Spool>> {
    let mut spools = spool::list(root)?;
    for spool in &mut spools {
        if Some(spool.manifest.id.as_str()) != live {
            spool.recover()?;
        }
    }
    Ok(spools)
}

/// The spool `id` under `root`, if it is there.
pub fn find(root: &Path, id: &str) -> io::Result<Spool> {
    if id.is_empty() || id.contains(['/', '\\', '.']) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a recording id",
        ));
    }
    Spool::open(&root.join(id))
}
