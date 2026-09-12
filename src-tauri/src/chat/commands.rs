//! Chat mode IPC command handlers (CONTRACT.md "Chat" section).

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::chat::local_models;
use crate::chat::providers::*;
use crate::db;
use crate::secrets;
use crate::types::*;
use crate::DbState;

pub(crate) type CmdResult<T> = Result<T, String>;


// ---- domain children (mechanical split of the former monolith) ----

mod api_keys;
mod approval;
mod artifacts;
mod generators;
mod llama_sidecar;
mod preview;
mod selection;
mod send;
mod sessions;

// Re-exported so every existing `crate::chat::commands::<item>` path and
// invoke_handler reference is unchanged; children see each other's
// pub(super) items through this chain via `use super::*`.
pub use api_keys::*;
pub use approval::*;
pub use artifacts::*;
pub use generators::*;
pub use llama_sidecar::*;
pub use preview::*;
pub use selection::*;
pub use send::*;
pub use sessions::*;
