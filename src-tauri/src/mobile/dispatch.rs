//! Testable dispatch function for new MobileMessage variants.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::AppHandle;

use super::protocol::{DesktopMessage, MobileMessage};
use super::relay_ws::WsSender;
use super::session_chat::SessionChatManager;
use crate::chat::ChatManager;

/// Dispatch a MobileMessage to the appropriate handler.
/// Returns DesktopMessages to send back over the relay.
/// For SendChatMessage, the caller must register the owner BEFORE calling
/// this function (so the streaming events have a destination).
pub fn dispatch_mobile(
    msg: MobileMessage,
    _app: &AppHandle,
    db: Arc<Mutex<Connection>>,
    chat_mgr: Arc<ChatManager>,
    _owner: Arc<Mutex<HashMap<String, WsSender>>>,
) -> Result<Vec<DesktopMessage>, String> {
    SessionChatManager::handle(msg, _app, db, chat_mgr)
}