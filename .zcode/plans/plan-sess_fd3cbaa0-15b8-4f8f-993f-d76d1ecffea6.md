## Goal
Fix the commit-modal crash (Commit / Commit & Push / Push buttons crash the app) and add auto-generated, editable commit messages based on the codebase diff.

## Part A — Crash fix: make `git_commit` / `git_push` async + offload blocking I/O

### Root cause
`git_commit` and `git_push` (`src-tauri/src/commands/git_cmds.rs:150, 157`) are **synchronous** Tauri 2 commands (`pub fn`, not `pub async fn`). In Tauri 2, sync commands run on the main thread. `git_commit` spawns 3 subprocesses (`git add .` + `git commit` + `git rev-parse`); `git_push` does a network round-trip that can take many seconds (especially during credential negotiation). Blocking the main thread that long freezes WebView2, which Windows then tears down — manifesting as the crash/white screen the user sees. The Rust itself is panic-free (all errors propagate via `?`); the handlers in `CommitModal.tsx` catch errors. So this is a thread-blocking freeze, not a thrown error.

### Fix — `src-tauri/src/commands/git_cmds.rs` (lines 148–160)
Make both commands `async` and move the blocking git calls onto a blocking thread via `tokio::task::spawn_blocking` (tokio is already a dependency). Run `verify_project_path` first (cheap DB lock + path check, no await needed), then move owned `PathBuf`/`String` into the closure:

```rust
#[tauri::command]
pub async fn git_commit(path: String, message: String, db: State<'_, DbState>) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::git_commit(&path, &message))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_push(path: String, db: State<'_, DbState>) -> CmdResult<String> {
    verify_project_path(Path::new(&path), &db)?;
    let path = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git::git_push(&path))
        .await
        .map_err(|e| e.to_string())?
}
```

`State<'_, DbState>` is used only in the sync `verify_project_path` call before any await, so it's not held across the spawn — no `Send` concern. Need to confirm `PathBuf` is imported (it likely already is in git_cmds.rs; if not, add it).

This frees the main thread during the git work, so WebView2 keeps pumping messages and doesn't crash. No frontend change needed for the crash fix itself.

### Out of scope (noted, not fixed here)
- Credential-manager hangs on `git push` (git may invoke a GUI credential helper). The async fix prevents the freeze, but a credential prompt could still hang the push. Separate concern.
- A frontend `ErrorBoundary` (none exists) — good defense-in-depth but not the crash cause. Leaving for a follow-up.

## Part B — Auto-generated commit message

Mirror the proven `generate_chat_title` pattern (`src-tauri/src/chat/commands.rs:447`): resolve the active session's provider/model/key, fetch the diff, call the one-shot LLM with a commit-message prompt.

### 1. `src-tauri/src/chat/commands.rs` — parameterize `anthropic_oneshot` + add the command
- **Add `max_tokens: u32` param to `anthropic_oneshot`** (line 413): Anthropic requires `max_tokens` and the title path hardcodes 32, which would truncate a commit message with a body. Update the two title-path call sites (lines 538, 544) to pass `32`. `openai_oneshot` needs no change (it omits max_tokens and lets the model stop naturally).
- **Add `generate_commit_message(path, chat_session_id, db)` command**, mirroring `generate_chat_title`:
  - Resolve provider/model/key/base_url exactly as title-gen does (lines 451–485), using the passed `chat_session_id`.
  - Fetch the diff via `git::get_git_diff(Path::new(&path))` (already exists, capped at 200KB), then truncate to ~8000 chars for the prompt.
  - If the diff is empty (nothing to commit), return `Ok(None)`.
  - System prompt: write a concise Conventional Commits message — imperative mood, ≤72-char subject, optional short body separated by a blank line, from the diff. Reply with ONLY the message.
  - Dispatch by provider (reuse the title-gen match block).
  - Clean the result (strip stray quotes / "Commit message:" prefixes) and return `Option<String>`.
  - `max_tokens`: pass 200 to `anthropic_oneshot` (room for subject + body).

### 2. `src-tauri/src/lib.rs`
Register `commands::chat::generate_commit_message` in the invoke handler (next to `generate_chat_title`).

### 3. `src/lib/ipc.ts`
Add `generateCommitMessage(path, chatSessionId)` binding → `safeInvoke<string | null>("generate_commit_message", { path, chatSessionId })`.

### 4. `src/components/chat/CommitModal.tsx` — pre-fill on open
- Add `chatSessionId: string` to props.
- Add a `generating: boolean` state, set true on mount.
- New `useEffect` on mount: call `generateCommitMessage(path, chatSessionId)`. On success, `setMessage(result)` (only if the user hasn't typed anything yet — don't clobber their input if they're fast). On error/no-result, silently leave the textarea empty. Set `generating: false` when done.
- Show a "Generating suggestion…" hint (e.g. placeholder text or a small label under the textarea) while `generating`.
- The textarea stays fully editable — the user can override the suggestion at any time.
- Disable the Commit/Commit & Push buttons only on `!message.trim() || busy` (unchanged) — generation is non-blocking, so the user can commit before it finishes if they type their own message.

### 5. `src/components/chat/GitToolsSidebar.tsx` — plumb the session id
Pass `chatSessionId={activeChatSessionId ?? ""}` to `<CommitModal>` (it already reads `activeChatSessionId` from the chat store for the project binding).

## What stays unchanged
- The diff fetch (`git::get_git_diff`) — reused as-is.
- The title-generation path — only the `anthropic_oneshot` signature changes (one new param, existing callers updated).
- `CommitModal`'s button handlers — unchanged (the crash is backend-side).

## Verification
- `cargo check` — async commands compile, new command registered, `anthropic_oneshot` signature updated.
- `npx tsc --noEmit` — clean (new prop, new IPC binding).
- `npm run test` — no regressions.
- Manual: open the commit modal → a generated message appears in the textarea within a second or two (editable); click Commit / Commit & Push / Push → no crash, the operation completes and the result shows inline.