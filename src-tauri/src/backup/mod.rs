//! Backups: automatic local snapshots plus the encrypted export/restore
//! container. See docs/superpowers/specs/2026-07-30-backups-design.md.

pub mod container;
pub mod restore;
pub mod snapshot;
