//! Tauri command handlers — thin wrappers over db/git/pty/secrets that
//! implement CONTRACT.md exactly. All argument names are camelCase on the JS
//! side (Tauri maps snake_case Rust params <-> camelCase JS automatically).

pub mod browser_cmds;
pub mod chat_cmds;
pub mod data;
pub mod git_cmds;
pub mod projects;
pub mod pty_cmds;
pub mod skills_cmds;
