# TTS Feature Research — Read Aloud for Assistant Messages & Artifacts

**Date:** 2026-09-11
**Status:** Research / proposal (no implementation yet)
**Scope:** Let users *hear* assistant chat messages and text artifacts instead of reading them.

---

## 1. TL;DR — Recommendation

Build a **two-engine TTS layer** behind one Rust proxy command, with playback in the webview:

| Phase | Engine | Why |
|---|---|---|
| **P1** (quick win, ~2–4 days) | **OpenAI-compatible `/v1/audio/speech`** proxied through Rust (works with OpenAI `gpt-4o-mini-tts`, Groq `playai-tts` — which has a large **free tier** — or any compatible endpoint). Plus **Web Speech API** as a zero-config fallback on Windows. | Reuses the exact STT proxy pattern (`commands/speech.rs`) and the `relay:chat:<provider>` keychain. No new dependencies. |
| **P2** (default engine, ~1–2 weeks) | **Kokoro-82M local** (Apache-2.0, int8 ≈ 82 MB download) via `sherpa-rs`/`kokoro-onnx` in-process, model delivered through the existing Hugging Face model-market download pipeline. | Free, offline, private, no key — matches the app's local-models philosophy. Kokoro tops the TTS Arena for open models and is described as "the closest thing to ElevenLabs" in open source. |

**Not recommended as the primary engine:** `speechSynthesis` (Web Speech API). It happens to work on Windows WebView2, but it is unreliable/broken in WKWebView (macOS) and WebKitGTK (Linux), offers no caching, no per-sentence progress control, and OS-dependent voice quality. Fine as a fallback; wrong foundation.

---

## 2. What exists today (from the codebase)

The speech infrastructure for the *other* direction (STT) already covers ~80% of what TTS needs:

| Need | Already exists |
|---|---|
| Sidecar/lifecycle + model catalog + downloads | `src-tauri/src/commands/stt.rs` — curated HF catalog (`catalog()` line 57), `SttHandle`/`SttState` (100–107), resolve-binary → spawn → health-poll, `stt.*` settings keys (40–42), auto-start hook (lib.rs:186–195), exit cleanup |
| Model download w/ progress + cancel + SHA verify | `src-tauri/src/commands/local_model_market.rs` (HF browse/download) + generic resumable pump in `src-tauri/src/download.rs` (`pump_body_to_file`, line 32 — format-agnostic, already used for non-GGUF whisper `.bin` files) |
| Reqwest proxy to a local speech server | `src-tauri/src/commands/speech.rs` — `transcribe_audio` (line 80) with cancellation slots. A `synthesize_speech` command mirrors this 1:1. **No `/audio/speech` call exists anywhere yet.** |
| Provider keys, never in the frontend | `src-tauri/src/secrets.rs` — OS keychain under `relay:chat:<provider>` |
| OpenAI-compatible HTTP template | `src-tauri/src/chat/llm_client.rs` — `openai_oneshot` (line 38) POSTs `{base}/v1/...` with Bearer auth |
| Per-message play button home | `src/components/chat/MessageBubble.tsx` — `MessageActions` hover toolbar (lines 269–354) with Copy/Regenerate/Edit/Delete; rendered for every non-live bubble (2122–2135) |
| Clean plain text of a message | `plainText` memo (MessageBubble.tsx:1832–1840) via `parseSegments` — already strips `<think>` blocks and tool markup; this is exactly what the Copy button reads. The TTS play button should read the same string. |
| Artifact text surface | `ArtifactPreviewPane.tsx` kind switch (lines 327–410): `markdown` (343), `text/code/json` (404) render full text; content comes from `read_artifact_preview` (`chat/commands.rs:3697`, 400 KB cap) → `readArtifactPreview` (`src/lib/ipc/harnessChat.ts:142`) |
| Audio plumbing in webview | `src/lib/sound.ts` (lazy shared `AudioContext`); mic capture in `ChatComposer.tsx`. **No TTS / `speechSynthesis` anywhere yet** (verified by grep). |
| Settings pattern | `get_setting`/`set_setting` (`db/settings.rs:9/18`), frontend `jsonSetting<T>()` factory (`src/lib/ipc.ts:413–433`), zustand keys in `src/state/settings.ts` |
| IPC registration spot | `tauri::generate_handler!` speech/STT cluster at `lib.rs:550–558` — `tts_*` commands go here; frontend wrappers in `src/lib/ipc/voice.ts` |

**Data flow (chat):** `send_chat_message` → `ChatManager::send` → provider SSE → `chat:token` events → `useChatStore.streaming` → `MessageBubble` renders; on completion the row persists and `MessageActions` appears — that's the play button's home.

---

## 3. Engine options surveyed

### 3A. Cloud TTS APIs

| Provider | Models | Price | Voices | Notes |
|---|---|---|---|---|
| **OpenAI** | `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd` | gpt-4o-mini-tts ≈ **$0.015/min** of audio (token-billed, $0.60/MTok in + $12/MTok audio out); tts-1 $15/1M chars; tts-1-hd $30/1M chars | 11 built-in, steerable via `instructions` param (tone/pacing/accent) | Drop-in `/v1/audio/speech`; MP3/Opus/WAV/PCM out. Known quirk: `instructions` occasionally leak into audio or get ignored. |
| **Groq** | `playai-tts` | **Free tier ≈ 2 h of audio/day**; paid ~$4–22/1M chars by voice | PlayAI voice catalog, **English + Arabic only**, 48 kHz out | OpenAI-compatible endpoint, extremely fast. Best "free cloud" option. |
| **xAI** | Grok Voice TTS 1.0 | $15/1M chars (≈$4.20 effective) | 5 voices | OpenAI-style API |
| **ElevenLabs** | Flash v2.5 / Multilingual v2 | Free 10k chars/mo (**no commercial license on free**); Starter $6/mo (30k); Creator $22/mo (121k); Flash ≈ 0.5 credit/char | Best-in-class quality (~82% pronunciation accuracy vs OpenAI 77%) | Proprietary API (not OpenAI-compatible) — needs its own adapter if ever added. Latency spikes under load. |
| **Zhipu (BigModel)** | GLM-TTS | Per-char pricing on bigmodel.cn; weights also open-sourced (`zai-org/GLM-TTS`, zero-shot cloning, zh+en) | Emotional/context-aware zh+en | Relevant for users with Z.ai keys; community wrappers expose it as an OpenAI-compatible `/audio/speech`. Worth an endpoint-compatibility check before committing. |
| Google Cloud | WaveNet/Neural2/Chirp 3 HD | $16–30/1M chars | many | Outpaced by specialists in 2026 comparisons; skip. |

**Cost sanity check for this app:** a typical assistant message is ~2,000 chars ≈ ~1.3 min of speech ≈ **$0.02 with OpenAI**. A heavy user reading 100 messages/day ≈ **$60/mo on OpenAI** — but **$0 on Groq's free tier** (2 h/day covers ~90 messages) and **$0 forever on local Kokoro**. This cost curve is the main argument for making local the *default*.

### 3B. Local / on-device

| Engine | Quality | Size | Speed (CPU) | License | Integration path |
|---|---|---|---|---|---|
| **Kokoro-82M** (v1.0 / v1.1-zh) | **#1 open model on TTS Arena**; "closest to ElevenLabs" per community benchmarks; en/fr/ja/ko/zh (+hi/pt/es/it in v1.0) | fp32 326 MB, **fp16 164 MB**, **int8 ≈ 82–92 MB** + `voices.bin` ~26 MB | ~7–11× real-time on modern CPU (a 1-min read synthesizes in ~6–9 s; sentence-chunked streaming hides this) | **Apache-2.0** — commercial OK, voices included | **`sherpa-rs`** (Rust bindings to sherpa-onnx, by thewh1teagle) or **`kokoro-onnx`** crate — in-process, no sidecar needed |
| **Piper** | Fast but noticeably more robotic | ~20–60 MB per voice | Very fast (RTF << 1), low RAM | MIT | `piper-rs`; good fallback for weak machines |
| **Chatterbox** (Resemble) | Good, adds emotion control + voice cloning | ~GBs, GPU-friendly | CPU-slow | MIT | Overkill for read-aloud; skip |
| **GLM-TTS (open weights)** | Strong zh+en, zero-shot cloning | Large, two-stage LLM pipeline | Needs vLLM/GPU realistically | Open weights | Not embeddable now; revisit if a GGUF/ONNX port appears |

**Integration choice within Kokoro:** in-process via `sherpa-rs` (recommended — matches Windows-first build, one less process) vs. a `whisper-server`-style sidecar (keeps synthesis off the UI thread's process, but requires packaging another binary; the whisper sidecar precedent makes this a viable fallback if ONNX-runtime linking on some platform hurts). Either way, the **model download reuses `download.rs` + the model-market progress UI**, exactly like whisper `.bin` models today.

### 3C. Web Speech API (`speechSynthesis`)

| Platform | Verdict |
|---|---|
| Windows (WebView2) | Generally works (Edge/Chromium engine, SAPI voices); needs user gesture in some cases |
| macOS (WKWebView) | Unreliable: `getVoices()` incomplete, silent failures |
| Linux (WebKitGTK) | Not officially supported; requires self-built WebKitGTK |

**Pros:** zero cost, zero download, per-sentence events, speed/pitch control. **Cons:** no cache, OS-dependent quality, cross-platform breakage, no audio bytes (can't save/reuse), voice mixing with the app's other audio is unmanaged. **Verdict:** optional fallback tier only, Windows-gated; never the primary engine for a cross-platform app.

---

## 4. Comparison summary

| | Local Kokoro | Cloud OpenAI | Cloud Groq (free) | Web Speech |
|---|---|---|---|---|
| Quality | ★★★★ (near-premium) | ★★★★ | ★★★ | ★★ (OS-dependent) |
| Cost | $0 | ~$0.015/min | $0 (< 2 h/day) | $0 |
| Offline / private | ✅ | ❌ (text leaves machine) | ❌ | ✅ |
| Setup | 82–164 MB download | API key | API key | none (Windows) |
| Latency first audio | ~0.5–2 s/sentence (CPU) | ~0.3–1 s | fastest (~0.1–0.3 s) | instant |
| Caching / reuse | ✅ easy | ✅ easy | ✅ easy | ❌ |
| Languages | en+zh (v1.1-zh), 5 langs (v1.0) | 50+ | en/ar | OS voices |
| License risk | none (Apache-2.0) | fine | fine | none |

---

## 5. Proposed design

### 5.1 Backend (Rust)

```
src-tauri/src/commands/tts.rs        (new — mirrors stt.rs/speech.rs)
├─ tts_speak(text, opts) -> AudioPayload        // engine = "local" | "openai_compatible" | "system"
│    ├─ local: sherpa-rs synthesis on a spawn_blocking thread (kokoro int8 onnx + voices.bin)
│    ├─ cloud: reqwest POST {base}/v1/audio/speech  (Bearer from relay:chat:<provider> keychain)
│    └─ returns raw audio bytes (wav/pcm local; mp3 cloud) + mime
├─ tts_stop() / tts_status()
├─ tts_engine_settings()  // install/download management like stt's catalog
└─ cache: app-data/tts-cache/<engine>-<voice>-<sha256(text+speed)>.<ext>
     (reuse the 30-day retention sweep precedent, lib.rs:110)
```

- Settings keys (`tts.*`, mirroring `stt.*`): `tts.engine`, `tts.voice`, `tts.speed`, `tts.cloudProvider`, `tts.model`, `tts.autoRead`, `tts.cacheEnabled`.
- Keys never touch the frontend — same invariant as STT/chat (`secrets.rs`).

### 5.2 Frontend

- **Play button** in `MessageActions` (MessageBubble.tsx:269–354) fed by the existing `plainText` memo (1832) — zero new text-extraction work.
- **Artifact read-aloud:** play control in `ArtifactPreviewPane.tsx` for `markdown`/`text`/`code` kinds; content already loaded via `readArtifactPreview`.
- **Playback:** a small `src/lib/tts.ts` manager on top of the shared `AudioContext` (precedent: `sound.ts`) —
  - split text into **sentences** (latin `.!?:;` + CJK `。！？；`), synthesize/play sequentially for gapless streaming; first sentence plays while later ones synthesize;
  - skip-forward/back per sentence, stop, speed (0.75×–2×), progress bar;
  - single-voice-at-a-time policy: starting a new message stops the previous one.
- **Text preprocessing:** reuse `parseSegments` (strips `<think>`, tool markup); additionally strip code fences/inline code, tables→prose summary line, skip KaTeX (or read the raw LaTeX — prefer skipping), cap at artifact-style lengths with "read first N" behavior for 400 KB files.
- **Optional extras (P3):** auto-read on message completion (needs one prior user gesture to satisfy webview autoplay policy — the first manual play unlocks it); karaoke sentence-highlighting in artifacts by mapping sentence index → rendered node; "download audio" button on artifacts.

### 5.3 Rollout

1. **P1** — `tts_speak` cloud proxy (OpenAI-compatible) + Web Speech fallback + play button + sentence queue + caching. ~2–4 days.
2. **P2** — Kokoro local engine: add Kokoro (int8 + voices.bin) to the model-market speech catalog, `sherpa-rs` integration, settings panel section modeled on `SttPanel.tsx`, make local the default once installed. ~1–2 weeks.
3. **P3** — auto-read, highlighting, audio export, voice-picker UI. As prioritized.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| ONNX runtime adds binary size / Windows build complexity (`sherpa-rs` links onnxruntime, ~15–30 MB) | Ship int8 model (82 MB) via on-demand download anyway; if linking hurts a platform, fall back to the whisper-server-style sidecar pattern (proven in this repo) |
| Long artifacts (400 KB) | Stream sentence-by-sentence; hard stop/replace policy; cache compiled audio per message |
| Cloud cost surprise | Local engine is default; cloud marked "premium voice" in settings; per-session char counter in the TTS panel |
| WebView autoplay policy blocks auto-read | Auto-read only after first user-gesture unlock; manual play always safe |
| Voice quality expectations (ElevenLabs envy) | Cloud engine slot is OpenAI-compatible; an ElevenLabs adapter is a small isolated addition later if users demand it |
| Chinese/multilingual users | Kokoro v1.1-zh covers zh+en; cloud engines cover the rest |

---

## 7. Sources

- OpenAI TTS guide & pricing: https://developers.openai.com/api/docs/guides/text-to-speech · https://developers.openai.com/api/docs/pricing · https://developers.openai.com/api/docs/models/tts-1
- Groq TTS (playai-tts): https://console.groq.com/docs/text-to-speech
- ElevenLabs pricing: https://elevenlabs.io/pricing
- Kokoro-82M (HF, Apache-2.0): https://huggingface.co/hexgrad/Kokoro-82M · ONNX builds & sizes: https://github.com/thewh1teagle/kokoro-onnx/releases · https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
- Kokoro quality/speed: TTS-Arena-topping & "closest to ElevenLabs": https://www.reddit.com/r/TextToSpeech/comments/1udgi9s/open_source_tts_comparison_kokoro_82m_vs/ · CPU benchmark gist: https://gist.github.com/efemaer/23d9a3b949b751dde315192b4dcf0653 · ~11× real-time CPU: https://www.reddit.com/r/LocalLLaMA/comments/1htwkba/introcuding_kokoroonnx_tts/
- Rust integration: https://github.com/thewh1teagle/sherpa-rs · https://crates.io/crates/sherpa-onnx · https://lib.rs/crates/piper-rs
- Web Speech API webview caveats: https://github.com/orgs/tauri-apps/discussions/8784 · https://v2.tauri.app/reference/webview-versions/ · https://developer.apple.com/forums/thread/723503
- 2026 API comparisons: https://www.coval.ai/blog/best-text-to-speech-providers-in-2026-how-to-choose-(and-why-vendor-benchmarks-lie)/ · https://inworld.ai/resources/best-text-to-speech-apis · https://gradium.ai/content/best-text-to-speech-apis-2026
- xAI TTS: https://x.ai/news/grok-stt-and-tts-apis
- Zhipu GLM-TTS: https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-tts · https://huggingface.co/zai-org/GLM-TTS · https://bigmodel.cn/pricing

---

# Implementation notes (added after building it)

Shipped as **local Kokoro-82M only** (the two-engine plan in §5 was dropped at
the user's direction: no cloud path, no Web Speech fallback). Backend is
`src-tauri/src/commands/tts.rs`; the player is `src/lib/tts.ts` +
`src/state/tts.ts` + `src/components/chat/TtsPlayerBar.tsx`.

Two of the assumptions in the research above turned out to be **wrong**, and
both were caught by measuring on real hardware rather than by reading
benchmarks. They are recorded here because the corrected versions drive the
shipped defaults.

## 1. int8 is SLOWER than fp32 on most CPUs (the opposite of the assumption)

§3B and the original catalog assumed int8 quantization was the right default
("~4x smaller … and roughly twice as fast"). Measured on an **Intel i7-10750H**
(Comet Lake — AVX2, **no VNNI**), same sentences, same engine:

| Variant | Threads | Throughput |
|---|---|---|
| int8, 103 MB | 4 | **0.33x realtime** |
| fp32, 305 MB | 4 | 0.84x realtime |
| fp32, 305 MB | 6 (all physical cores) | **1.06x realtime** |
| fp32, 305 MB | 12 (all logical) | 0.81x realtime |

fp32 is **~2.5x faster** than int8 here. int8 dynamic quantization only pays off
where the CPU has int8 acceleration (VNNI — roughly Ice Lake / Zen 4 and
newer); without it ONNX Runtime pays a quantize/dequantize tax per op. Most
laptops in the field predate VNNI, so **fp32 is the shipped default** and int8
is offered only as a smaller download with that caveat spelled out in the UI.

Thread count also matters and "more" is not "faster": past the physical core
count the session's own parallelism contends with itself. The engine now uses
half the logical cores (which lands on the physical count on hyperthreaded
machines), clamped to 2..=8.

Net effect of both fixes: **0.33x → 1.07x realtime**, i.e. from unable to keep
up with playback to keeping pace with it.

> Caveat on these numbers: they were taken on one laptop CPU. A machine with
> VNNI may well favour int8. The defaults are chosen so the *common* case is
> safe; int8 remains a one-click alternative for anyone who wants to try it.

## 2. GPU acceleration is NOT reachable through the Rust crate

§3B's integration note assumed a provider could be selected at runtime. It
cannot. Setting `provider: "cuda"` on the shipped crates.io build logs:

```
Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON.
Available providers: CPUExecutionProvider, . Fallback to cpu!
```

The `sherpa-onnx-sys` build script only ever fetches CPU archives, and there is
no CUDA/DirectML cargo feature. So **a GPU toggle in the settings UI would be a
placebo** — it is deliberately not shipped.

Getting GPU would mean one of:

1. **Link a CUDA build at build time** — set `SHERPA_ONNX_LIB_DIR` to the
   extracted `sherpa-onnx-v1.13.8-cuda-13.x-cudnn-9.x-…-win-x64-cuda.tar.bz2`
   (456 MB; the CUDA 12.x variant is 567 MB). Consequences: the shipped binary
   then *requires* the CUDA + cuDNN 9 runtime DLLs to load at all, for every
   user, GPU or not — a distribution regression for a desktop app that
   currently has no CUDA requirement.
2. **A CUDA sidecar** — download that bundle on demand (the whisper-server
   one-click-install pattern) and invoke `sherpa-onnx-offline-tts.exe` per
   synthesis. This keeps the app CUDA-free until opted in, but the bundle is
   ~456 MB, NVIDIA-only, still needs a CUDA/cuDNN runtime, and pays a ~2.5 s
   model load per process invocation (so it wants whole-text synthesis rather
   than per-sentence streaming).

Neither is a small change, and the measured CPU path (~1.07x realtime, with the
player buffering a few sentences ahead) is adequate for read-aloud, so GPU is
left as a documented option rather than shipped. Note the target machine *does*
have an NVIDIA GTX 1660 Ti and CUDA 13.0 installed, so option 1 or 2 is viable
if the CPU throughput is ever judged insufficient.

---

# Update: downloads, GPU, and load policy

Three changes after the first round of real use, all driven by measurement.

## 1. The model download was failing — it was our HTTP client, not the host

The first implementation pulled the bundle as a single tar.bz2 from the
sherpa-onnx **GitHub** release, with a client built as `.no_proxy()`. That flag
is right for every other network call in the speech stack (they all talk to a
loopback sidecar), and wrong for a download: this machine reaches the internet
through a system proxy (`ProxyEnable=1`, `ProxyServer=127.0.0.1:7890`), so
bypassing it turned a working download into an unreachable-host failure. The
model market's downloads never set that flag, which is why GGUF models worked
while TTS models did not. The same bug was present in the pre-existing
`stt_install_server` (whisper-server one-click install) and is fixed there too.

Models now come from **Hugging Face**, which is also where this app already
sources models (token handling included). HF has no "download this repo as one
archive" endpoint (both `/tarball/main` and `/zip/main` 404), so a bundle is
~377 individual files — the install is a concurrent multi-file fetch (8 at a
time, per-file resume by size, `.part` staging, cancel-aware) rather than
download-then-extract.

Verified by a network integration test rather than by inspection:

```
cargo test --lib hf_download -- --ignored --nocapture
    listed 377 files
    tokens.txt: 687 bytes
    ok
```

Only the multilingual repos are offered: `csukuangfj/kokoro-en-v0_19` holds just
a `.gitattributes` on HF, and the int8 variants are GitHub-only. Nothing is lost
— the multilingual model carries the full English voice set (11 `af_`/`am_`/
`bf_`/`bm_` voices).

## 2. GPU: real, but as a child process — and only where the runtime exists

A provider setting on the in-process engine was tried first and removed: setting
`provider: "cuda"` on the crates.io build logs

```
Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON.
Available providers: CPUExecutionProvider, . Fallback to cpu!
```

so it was a placebo. The crates.io build links CPU-only libraries and there is
no CUDA feature to enable.

GPU now runs the vendor's **CUDA build of `sherpa-onnx-offline-tts`** as a
short-lived child process, installed on demand (456 MB engine + 420 MB cuDNN 9,
both SHA-256 pinned and verified before extraction — the engine binary is
executed, so TLS alone is not sufficient). cuDNN comes from NVIDIA's own PyPI
redistribution; the CUDA runtime is detected from an existing toolkit install.

**Measured, same sentence, best of three** (i7-10750H / GTX 1660 Ti):

| | synthesis (9.49 s of audio) | incl. process start + model load |
|---|---|---|
| CPU TTS, 6 threads | 6.37 s = 1.49x realtime | 10.10 s = 0.94x |
| GPU TTS (CUDA) | 2.08 s = **4.56x realtime** | 6.56 s = 1.45x |

| | model load | per clip |
|---|---|---|
| STT CPU, 8 threads | 1.79 s | 1.86 s |
| STT CUDA | 3.35 s | **0.20 s** (0.84 s first call, CUDA warm-up) |

So GPU is ~3x faster for TTS synthesis and ~9x faster per STT clip, while
paying more per model load. That asymmetry is why the two features handle it
differently, and it is why the player asks for **larger chunks in GPU mode**
(1200 chars vs 240): one model load per sentence would spend 4.5 s loading for
every two seconds of audio. In CPU mode the opposite holds — sentence-sized
chunks start playing sooner.

Both devices are user-selectable (a CPU/GPU choice in each of the STT and TTS
tabs). Selecting GPU for STT **refuses to fall back to the CPU build** — running
on hardware the user did not choose while the UI claims GPU would be a lie.
STT detects a CUDA whisper.cpp build in the app's `bin/whisper-cpp-cuda` folder;
TTS installs its own runtime with one button.

## 3. Load policy is a setting, not an assumption

`tts.keepLoaded` chooses between loading on first use and loading at app start
(released on exit, alongside the existing exit-time unload). It is CPU-only by
construction: the GPU path has no resident engine, so the toggle is disabled
with that explanation rather than silently doing nothing. Turning it on when
there is no model installed is refused and the setting reverts, so the stored
value never promises something the app will not do.

## 4. A GPU install failed partway — transient, but the code made it fatal

The first real GPU install died with:

```
the cuDNN runtime download failed: error sending request for url
(https://files.pythonhosted.org/.../nvidia_cudnn_cu13-9.26.0.51-...whl)
```

That host is reachable (both direct and through the proxy, verified with curl),
so the request failure was transient — the CUDA engine's 456 MB had just come
down the same connection. What turned a blip into a hard failure was the code:
`download_pinned` had **no retry and no resume**, so any drop restarted the
transfer from zero, and a `.part` file was overwritten rather than continued.

Two fixes, both verified:

1. **Retry with resume.** Up to 4 attempts with exponential backoff, and each
   retry sends `Range: bytes=<have>-` so it continues from the partial file. If
   a server ignores the range and answers 200, the partial is truncated and the
   fetch restarts — correctness never depends on server cooperation. A SHA-256
   mismatch deletes the partial instead of resuming onto corrupt bytes.
2. **Windows system proxy support.** reqwest only honours `HTTP_PROXY` /
   `HTTPS_PROXY`; a proxy configured in Windows' Internet Settings (what curl,
   pip and browsers use — and what this machine has, `127.0.0.1:7890`) was
   invisible to it. `http_client()` now reads the registry and applies it, with
   loopback excluded so local sidecars are never routed through a proxy.

Verified from the app's own client, not from curl:

```
cargo test --lib can_reach_the_gpu_download_hosts -- --ignored --nocapture
    system proxy: Some("http://127.0.0.1:7890")
    cuDNN (files.pythonhosted.org): HTTP 206 Partial Content, 1024 bytes
    CUDA engine (github.com):       HTTP 206 Partial Content, 1024 bytes
```

The 206s double as proof that range requests are honoured, which is what makes
the resume real rather than theoretical.

### 4a. Retry made it worse: the "416 Range Not Satisfiable" follow-up

The retry/resume fix above introduced its own failure. The next install died with:

```
the cuDNN runtime download failed: HTTP 416 Range Not Satisfiable
```

The partial on disk was at or past the expected size, so the resume asked for
`Range: bytes=<have>-` starting at (or beyond) the end of the file — a range the
server is entitled to reject, and 416 was treated as non-retryable. The partial
had got that big because a 206 was trusted blindly: if an intermediary answers a
ranged request with the *whole* body, appending it doubles the file, and the
next attempt then asks for an impossible range.

Three changes, in order of how much they matter:

1. **Resume only on a confirmed offset.** The `Content-Range` start must equal
   the byte count already on disk; anything else (missing, or a different
   offset) falls back to a clean truncated restart. This stops the corruption
   instead of cleaning it up afterwards.
2. **An unusable partial is discarded, not resumed.** `have >= expected` means
   the partial cannot be continued, so it is deleted and the fetch starts at
   zero — which cannot itself 416.
3. **416 is recoverable**, not fatal: drop the partial and retry.
4. **A completed body is length-checked** before the SHA pass, because a clean
   early close at the wrong length is indistinguishable from success at the
   stream level. A mismatch retries; it does not surface as corruption.

The decision logic is now two pure functions with unit tests
(`partial_is_resumable`, `length_is_expected`), plus a live end-to-end test:

```
cargo test --lib resume_path -- --ignored --nocapture
    resume_path_completes_and_recovers_from_a_corrupt_partial ... ok
```

which seeds a real partial, resumes it against Hugging Face, verifies the
SHA-256, and then seeds an oversized partial to prove the 416 path recovers.

> A note on that test: its first run failed with a SHA mismatch that looked like
> a code bug. It was not — the expected digest had been computed with
> `curl <url> | sha256sum` without `-L`, which hashes the 307 redirect stub and
> yields a wrong-but-plausible constant. Range-concatenation reproduces the real
> file hash exactly, so the download path was right and the test data was wrong.

## 5. Making the voice sound like it understands the text

"It doesn't know where to take pause or how to say certain things" turned out to
be three separate defects plus a missing normalisation pass. Writing tests for
the audible behaviour is what surfaced them — none are visible in the rendered
answer.

**Bugs the tests caught:**

1. **CJK never split.** Sentence splitting required whitespace after a
   terminator (`(\s+|$)`) because that is what protects `3.14` from splitting
   mid-number. Chinese and Japanese put no space after `。！？`, so an entire
   Chinese answer was handed to the engine as ONE chunk — a huge latency hit and
   no sentence granularity at all. The terminator pattern is now two branches:
   Latin terminators must be followed by whitespace or end-of-text, CJK ones
   need no such guard. (A lookahead, not a lookbehind — lookbehind is a parse
   error on older WKWebView and would break the whole module.)
2. **PascalCase identifiers were not split.** The pattern required a lowercase
   *start*, so `MessageBubble` — the most common shape in a code answer — stayed
   one run-together token and got mangled. Now a capital following a
   lowercase/digit opens a word, and a capital followed by lowercase closes an
   acronym run (`HTTPServer` → "HTTP Server").
3. **The paragraph flag landed one sentence early.** The whitespace captured
   with a sentence is the gap that FOLLOWS it, so it describes the *next*
   sentence; assigning it to the current one put the long pause before the wrong
   sentence.

**What was missing:**

- **Semicolons and commas no longer split.** They are breaths inside a sentence;
  cutting there inserted a full stop's worth of silence mid-thought — literally
  a voice that does not know where to pause. Only strong terminators split now.
- **Paragraph breaks are preserved** (the markdown pass used to collapse blank
  lines) and playback inserts ~280 ms before a new paragraph, so a list of
  points reads as separate points instead of a run-on.
- **Headings end in a full stop** so the body does not start on the heading's
  last word, and dashes used as asides become a comma beat.
- **A speech normalisation pass**: `e.g.` → "for example", `i.e.` → "that is",
  `etc.` → "et cetera", `&` → "and", `→` → "to", `≥`/`≈`/`×`/`%` spoken out, and
  identifiers spaced (`max_sentence_chars` → "max sentence chars").

Covered by `src/test/ttsSpeech.test.ts` (13 tests), which runs offline.
