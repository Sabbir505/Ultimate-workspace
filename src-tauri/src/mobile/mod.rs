//! Mobile companion app relay — WebSocket transport wrapper.
//!
//! The desktop acts as the execution host: the phone never holds API keys.
//! All model calls happen on the desktop via the existing ChatProviderAdapter
//! infrastructure. The relay is purely a transport layer that accepts
//! connections from the mobile app over a localhost WebSocket and routes
//! chat requests through the exact same code path as desktop chats.

pub mod commands;
pub mod dispatch;
pub mod protocol;
pub mod relay;
pub mod relay_owner;
pub mod relay_ws;
pub mod session_chat;
pub mod tailscale;

#[cfg(test)]
mod relay_tests;
#[cfg(test)]
mod session_chat_tests;
