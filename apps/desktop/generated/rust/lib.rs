//! The desktop app's wire types, generated from the zod schemas in `@omni/contracts`: the
//! Storage sync protocol (docs/spec/desktop.md, "The sync protocol") and the meeting recorder's
//! bridge (docs/spec/meetings.md, "The desktop recorder"). Never edit the generated files by hand.

// Formatted by quicktype, not rustfmt: `cargo fmt --check` would fight the generator.
#[rustfmt::skip]
mod storage_sync;
#[rustfmt::skip]
pub mod desktop_recorder;

pub use storage_sync::*;
