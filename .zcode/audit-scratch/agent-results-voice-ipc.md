# Agent findings: voice/IPC libs (~34 files)
# Status: COMPLETE — verified result captured 2026-10-02 19:26

FILES COVERED: src/lib/{tts,ttsStream,ttsPreview,voiceActivity,voiceDictationCore,voiceRecording,sound,ipc,ipcCore}.ts + all 26 files in src/lib/ipc/ (wiki, github, prompts, chatSessions, mcp, automations, budget, hooks, localModels, subagents, artifacts, sessionMesh, harnessChat, llmLogs, workspaces, pricing, rag, appearance, vault, imageGen, voice, updater, modelMarket, marketFiles, exportImport, approvals). Spot-verified voice-path command signatures (transcribe_audio in commands/speech.rs:80 — camelCase wrapper matches) and event names (browser:url-changed, checkpoint:created, docs:corpus:updated all emitted by backend) — no event-name/arg mismatches.

## P0

**1. `beginVoiceRecording` re-entrancy race leaks an open mic, a live AudioContext, and an orphaned transcription interval (mic stuck on) — voiceDictationCore.ts:453.**
```ts
const beginVoiceRecording = useCallback(async () => {
    if (recordingRef.current || transcribing) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
```
`recordingRef.current` is only set true at line 539, *after* the getUserMedia await plus the whole graph build. A second activation while the first is pending (double-click on the mic button — it stays enabled because ChatComposer.tsx:870 is `disabled={transcribing || loopActive}`, both false during the await; or a second Alt press while the Windows permission prompt is up — the keydown guard at :644 checks the same stale ref) passes the guard and runs a second capture, overwriting `captureCtxRef` (:480), `captureNodesRef` (:524), `captureStreamRef` (:525), `partialTimerRef` (:547) without tearing down the first. Consequences: first MediaStream tracks never stopped (recording indicator on until exit), first AudioContext never closed, first onaudioprocess keeps pushing chunks (doubled audio to the transcriber), first 1.5s setInterval leaks forever — issuing transcribeAudio IPC calls as long as the leaked processor fills segmentRef. stopCapture/cancelVoiceRecording/unmount can only close the latest refs. Fix: latch synchronously at entry (`openingRef`), defensively clear existing interval/ctx/nodes/stream at the top before overwriting.

## P1

**2. The strikethrough substitution destroys `~~~` code-fence markers before the fence-strip pass runs, so `~~~`-fenced code is voiced as prose — tts.ts:499 vs :629.**
`markdownToSpeech` runs the whole SPEECH_SUBSTITUTIONS loop (:622-626) *before* the fenced-code strips. On `~~~python\nx = a + b\n~~~`, the strike rule `[/~~([^~]+)~~/g, "$1"]` matches starting at the second tilde and rewrites to `python\nx = a + b\n~` — by the time :629's `~~~` strip runs there is no `~~~` left, so the code body survives and is then mangled by later rules (`=` → " equals ", `+` → " plus ") and voiced in full. Hits exactly the case `~~~` fences exist for (code containing nested ``` blocks) in both `play()` and the streaming feeder (ttsStream.ts:72). Fix: strip fenced blocks at the top of markdownToSpeech, or narrow the strike rule with lookaheads (allowed — only lookbehind is banned): `[/~~(?!~)([^~]+)~~(?!~)/g, "$1"]`.

## P2

**3. `next()`/`prev()` at the queue boundary replays the current sentence from its start instead of no-op — tts.ts:1300-1314.**
On the last chunk, `next()` clamps skipTarget to this.index, calls `stopSource("ended")` (cutting mid-word), and the pump replays that index with offset 0 — the final sentence restarts from its beginning. Same for prev() on the first. Fix: early return when `clamped === this.index` and nothing pending.

**4. Bullet-list markers stripped without the promised sentence break — tight list items read as one run-on — tts.ts:656-658.**
Comment says the bullet "becomes a full stop" but the replacement is `""`. For a tight list whose items lack terminators (`- First point\n- Second point`), items collapse into a single un-terminated chunk (single \n isn't a paragraph break, no PARAGRAPH_PAUSE_MS either). Fix: replace with `". "` per the documented intent.

**5. Duplicated `base64ToBytes` decoder in the two TTS modules — tts.ts:842-847 and ttsPreview.ts:42-47.**
Byte-identical. Export once (sound.ts next to the shared AudioContext, or audioBytes.ts); voiceRecording.ts already centralizes the input-side WAV/base64 utilities.

Layer verdicts: the IPC layer (ipcCore.ts, ipc.ts, all 26 ipc/* modules) is CLEAN — every listener factory returns the unlisten promise, safeInvoke/safeListenChecked have coherent null semantics, arg/event names match the Rust backend on the voice path, no per-render subscriptions or dropped error paths. Audio teardown in voiceActivity.ts and the normal stopCapture path is correct — the mic-leak class exists only via the P0 re-entrancy race. TTS player token/cancel machinery handles stop-during-load, replay supersession, streaming feeds correctly; sentence cache bounded (trimBuffers).
