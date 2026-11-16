//! The Storage sync protocol's wire types (docs/spec/desktop.md, "The sync protocol"), generated
//! from the zod schemas in `@omni/contracts`. Never edit `storage_sync.rs` by hand.

// Formatted by quicktype, not rustfmt: `cargo fmt --check` would fight the generator.
#[rustfmt::skip]
mod storage_sync;

pub use storage_sync::*;
