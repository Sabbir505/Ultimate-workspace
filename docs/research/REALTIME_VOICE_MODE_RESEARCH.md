# Real-Time Voice Mode — Streaming STT + Streaming Kokoro + Barge-in; S2S Evaluation

**Date:** 2026-09-30
**Status:** Research / proposal (no implementation yet)
**Scope:** The §6 Tier-2 #9 proposal — turn Relay's push-to-talk dictation + read-aloud stack into
a hands-free, interruptible voice loop, and evaluate whether a local speech-to-speech (S2S) sidecar
(Moshi / Ultravox) should replace the pipeline later.
**Builds on:** `docs/research/TTS_FEATURE_RESEARCH.md` (engine selection — implemented: Kokoro-82M
in-process via sherpa-onnx).

---

## 1. TL;DR — Recommendation

**Build the pipeline first; treat S2S as a watchlist, not a dependency.**

| Phase | What | Why now | Effort |
|---|---|---|---|
| **A** | **Barge-in v1** — interrupt read-aloud with your voice | The dictation stack already has energy VAD + mic capture; the playback queue already supports per-sentence cancel. This is wiring, not new engines. | S (~2–4 days) |
| **B** | **True streaming STT** — sherpa-onnx streaming zipformer for partials | Relay already ships the `sherpa-onnx` crate for TTS; the same crate carries streaming ASR + Silero VAD. Kills the 1.5 s re-transcription cadence and the 20 s force-commit ceiling. | M (~3–5 days) |
| **C** | **Sub-sentence TTS streaming** — synthesis via the vendored sherpa-onnx audio-progress callback | The vendored `sherpa-onnx-sys 1.13.8` already exposes `SherpaOnnxGeneratedAudioProgressCallbackWithArg`; first-audio can drop from "first sentence" (~1–3 s on CPU) to ~200–500 ms without a new dependency. | M (~3–5 days) |
| **D** | **Voice-session UX** — a continuous loop (listening → thinking → speaking) with wake/PTT modes, cost integration | Assembles A–C into the product feature. | M (~1 week) |
| **E** | **S2S sidecar evaluation spike** (Moshi on WSL2/CUDA, Ultravox via vLLM) | Interesting, but none of the 2026 S2S models call tools, and Relay's voice must drive the same 45-tool registry. See §7. | L–XL, deferred |

Phases A–C ship a genuinely competitive hands-free voice mode (first response audible in well under
a second on GPU, interruptible at any word) while keeping the **text-mediated** architecture —
which is what makes tool calling, permissions, checkpoints, and cost attribution work for free.
The S2S models short-circuit text and therefore bypass all of that; §7 explains when that trade
flips.

---

## 2. What exists today (code-verified 2026-09-30)

The doc's framing ("turn-based pipeline only") undersells how much of the loop already exists:

| Capability | State | Where |
|---|---|---|
| Mic capture + energy VAD | **Exists** — 16 kHz AudioContext, 256 ms chunks, ~0.77 s pause (3 chunks) commits a segment | `src/lib/voiceDictationCore.ts` (`silenceRunRef`, `SEGMENT` logic) |
| Streaming-ish partials | **Exists** — the un-committed segment is re-transcribed every 1.5 s and the partial is re-rendered in place; force-commit at 20 s | `voiceDictationCore.ts:17-20` |
| ASR | whisper.cpp **server sidecar**, HTTP, with per-request cancellation slots ("partial"/"commit" tags) — a cancelled request aborts server-side inference early | `src-tauri/src/commands/speech.rs:18-35` |
| TTS | Kokoro-82M **in-process** via sherpa-onnx (`OfflineTts`), int8 bundles from k2-fsa, per-(model,voice,speed,text) WAV disk cache | `src-tauri/src/commands/tts.rs:1-40` |
| TTS streaming | **Sentence-level** — the frontend splits the answer and synthesizes/plays sentence-by-sentence so playback starts on the first sentence | `src/lib/tts.ts:3-24` |
| TTS GPU | CUDA runtime already packaged as a separate sidecar dir (`sherpa-onnx-cuda`) | `src-tauri/src/commands/tts_gpu.rs`, `build_updates.rs:68` |
| LLM stream cancel | Exists (silence-watchdog reconnect ladder + cancel paths) | chat stream lifecycle |
| Barge-in / duplex audio | **Missing** — no VAD during playback, no echo handling, no simultaneous capture+playback | — |

Two constraints recorded in `tts.ts` matter for the design:
- **CPU synthesis runs at roughly playback speed** → sentence-sized chunks are the unit that makes
  per-sentence navigation and pause exact; GPU (CUDA build) can batch larger.
- The backend synthesizes ~10× realtime on GPU, so per-sentence calls spend most of their time on
  engine warm-up amortization — batching matters.

---

## 3. Target UX and the latency budget

Hands-free mode: the user speaks; text lands live in the composer/bubble; the answer starts speaking
before it finishes generating; the user can interrupt at any word; Relay yields the floor.

Latency budget (aligned with the 2026 industry guidance that the whole interruption path should
land under ~150 ms per component, ~300–500 ms end-to-end):

| Leg | Budget | Mechanism |
|---|---|---|
| Speech → partial text | ≤ 300 ms | streaming ASR (Phase B) |
| Partial → LLM first token | ≤ 400 ms | existing streaming path |
| First token → first audio | ≤ 500 ms | first-sentence chunk + callback streaming (Phase C) |
| Barge-in detected → audio stopped | ≤ 150 ms | VAD on post-AEC mic signal → cancel playback queue + LLM stream |
| Barge-in → floor yielded | ≤ 300 ms total | turn state machine (§6) |

---

## 4. Piece 1 — streaming STT

Relay's current "partial" is **re-transcription**: every 1.5 s the whole un-committed segment goes
back through the whisper server. That works for dictation but is the wrong shape for a live loop —
cost grows with segment length, partials are coarse, and the 20 s force-commit exists precisely
because the model is batch.

Options surveyed (2026 landscape):

| Option | Streaming model | Latency | Fit for Relay |
|---|---|---|---|
| **sherpa-onnx streaming zipformer** | True transducer streaming, chunked decode | ~100–300 ms partials on CPU | **Best** — same crate Relay already ships for TTS (one dependency, one catalog/download pipeline, no sidecar process); CPU-only so it never fights the GPU |
| **Moonshine (v2 "ergodic streaming encoder")** | Streaming encoder tuned for edge/latency | Words as you speak, CPU-friendly | Strong accuracy-per-compute; but a second engine + download pipeline for a job the sherpa crate already covers |
| **Kyutai STT (stt-2.6b-en, 1B variants)** | Decoder-based streaming, word timestamps, robust to noise, 2 h audio | Excellent latency/accuracy trade | GPU-class; heavier; more interesting later as the "premium" partial engine |
| **NVIDIA Parakeet/Canary** | CTC, batch-oriented | Top throughput/accuracy on GPU | Batch transcriber, not a conversation partials engine |
| **whisper.cpp incremental** | Batch per segment (current) | 1.5 s cadence | Keep for the **commit** pass (accuracy) — pairing whisper-commit with zipformer-partials is the recommended split |

**Recommendation:** streaming zipformer via the existing `sherpa-onnx` crate for partials + endpoint
decisions, whisper.cpp remains the final commit pass (accuracy on completed segments). This adds no
new runtime dependency and reuses the model-market download plumbing. Silero VAD (also in the
sherpa crate) replaces the hand-rolled energy run-length detector for endpointing — energy VAD
false-triggers on keyboard/hum, which matters once the mic is open hands-free.

---

## 5. Piece 2 — streaming Kokoro

Sentence-level chunking already hides most of the wait, but "first sentence synthesized" is still
**1–3 s after the first token on CPU** (long first sentence, espeak-ng phonemization, full-sentence
WAV returned as one buffer). Two upgrades, in order of value:

1. **Callback streaming from the existing engine.** The vendored `sherpa-onnx-sys 1.13.8` exposes
   `SherpaOnnxGeneratedAudioProgressCallbackWithArg` — audio arrives as generated, not as a final
   buffer. Emitting base64 chunks per callback (or writing a streamed temp WAV per sentence)
   turns "first sentence" into "first ~100–200 ms of audio" with no new dependency and no engine
   change. This is the single highest-leverage change in the whole proposal.
2. **Sub-sentence chunking for the first chunk only.** Keep sentence units for cache/navigation,
   but split the *first* sentence at the first comma/conjunction so playback starts ~300 ms after
   the first token. 2026 references put Kokoro's first-chunk at ~45 ms on high-end GPUs; the
   realistic local target is 200–500 ms first-audio on CPU/GPU.
3. **Pipeline synthesis with playback** — synthesize sentence N+1 while N plays (the playback queue
   already exists in `tts.ts`; the GPU build makes synthesis ~10× realtime, so the queue rarely
   starves).

The espeak-ng phonemizer is the known CPU bottleneck inside Kokoro; if it shows up in profiles the
escape hatch is a phoneme-cache keyed like the existing WAV cache (repeated phrases are common in
agent speech: "I'll check the file", status restatements).

---

## 6. Piece 3 — barge-in (the genuinely hard part)

Barge-in is an **echo problem** before it is an interruption problem: with speakers (not
headphones), the mic hears Relay's own TTS, and the agent interrupts itself forever. Industry
recipes (Coval, RunEdge, FutureAGI 2026 guides) converge on:

- **AEC (acoustic echo cancellation)** with the TTS output as the far-end reference — WebRTC AEC3
  or lighter SpeexDSP AEC — then **Silero VAD on the post-AEC signal** to decide "user is talking".
- Total pipeline budget: detection + audio stop + LLM cancel + floor yield ≈ 150 ms per component.

Relay-specific design:

| Speaker mode | Mechanism | Cost |
|---|---|---|
| **Headphones (default)** | No AEC needed — capture is clean. VAD (Silero via sherpa crate) on the mic during playback; energy gate above the playback noise floor. | ~0 — ships in Phase A |
| **Speakers, v1** | **Ducking, not cancellation**: while TTS plays, keep mic VAD hot but require a sustained (300 ms) above-threshold signal *post-duck* (pause playback for the detection window). Simpler and echo-proof; costs a stammer on interruption. | Phase A fallback |
| **Speakers, v2** | Real AEC: WebRTC `audio-processing` crate (AEC3) with the TTS stream as reference, or SpeexDSP AEC as the lighter option. Windows-first is fine (WebView2 + WASAPI loopback gives a clean reference signal). | Phase D+, only if users actually use speakers |

Interruption semantics (the part that makes it feel good rather than broken):
- VAD trigger → **stop playback immediately** (drop the remaining sentence queue — synthesis for
  queued-but-unstarted sentences is cancelled before it starts), then **cancel the LLM stream**,
  then hand the floor to listening with the partial transcript preserved.
- Discard the *unheard* audio but keep the heard prefix in the bubble (the user knows what was
  said); the chat record keeps the full text either way.
- A 250 ms "confirm" window (speech must be real speech, not a cough — Silero score threshold) to
  avoid self-interruption ghosts.

---

## 7. S2S sidecar evaluation — Moshi, Ultravox, and the 2026 field

### The architectural problem that decides this

Relay's voice must drive **the same 45-tool registry, permission ladder, checkpoints, and cost
dashboard** as typed chat. The pipeline architecture (STT → text → LLM → TTS) gets all of that for
free because the model sees and emits **text**. S2S models map audio → audio (or audio → tokens)
directly, so unless the model exposes a text side-channel, tool calls, diffs, approval cards, and
cost accounting have nothing to attach to. This — not latency — is the main reason S2S is a
watchlist item.

### Moshi (Kyutai) — the only true full-duplex local option

- Full-duplex: models **two simultaneous audio streams** (user + agent) with Delayed Streams
  Modeling; **Inner Monologue** = text tokens generated first, conditioning the audio — the text
  stream is the natural hook for tools, and could in principle be parsed by Relay's tool layer
  while speech continues.
- **Latency: 160 ms theoretical (80 ms frame + 80 ms acoustic delay), ~200 ms practical** on an L4.
- **Cost of running it:** Helium 7B backbone → ~16–20 GB VRAM at fp16, ~10 GB quantized;
  `moshi-server` (Rust) targets **Linux + CUDA — on Windows the realistic path is WSL2**, which
  collides with Relay's Windows-first, single-EXE sidecar pattern. Serves 4–8 concurrent sessions
  on 24 GB.
- **License:** weights CC-BY 4.0 (attribution), code MIT/Apache-2.0 — fine for a desktop app.
- **Verdict:** technically the most elegant fit for a *voice conversation* (real turn-taking, real
  interruption, sub-200 ms), but it is a **second brain** with no tool access, its own persona, and
  a WSL2 deployment tax. As of 2026 there is no surfaced function-calling integration; the inner
  monologue hook is promising but DIY.

### Ultravox (fixie.ai) — voice *input*, not S2S

- Multimodal LLM that consumes audio **directly into the LLM embedding space** (Whisper encoder →
  projector → Llama 3.1/Mistral backbone) — "no separate ASR stage". Positions itself as the
  open-weight GPT-4o-Realtime alternative.
- **TTFT ~400 ms, ~50–80 tok/s with audio** (v0.4-70B card); ~600 ms voice latency demonstrated on
  hosted vLLM deployments.
- **Serving: vLLM is the official path; no llama.cpp support surfaced in 2026** — that means a new
  serving stack (vLLM is Linux/GPU-first) for a model that still needs Relay's whole TTS leg
  afterwards. It replaces whisper, not the pipeline.
- Sizes 0.5B→70B; smaller variants are plausible GPU-sidecar candidates; license Apache-2.0.
- **Verdict:** an ASR *upgrade* (emotion/tone awareness, no transcription round-trip), not an
  architecture change. Only worth revisiting if llama.cpp grows audio-encoder support or if Relay
  ever ships a Linux GPU server mode.

### The 2026 field beyond the doc's two names

| Model | Shape | Note |
|---|---|---|
| **Qwen3-Omni** | True S2S, omni-modal | The community's "perfect on paper" pick — real-time speech-to-speech, but real-world speech *generation* quality questions persist (Hacker News 2026 threads); heavy VRAM; Apache family |
| **GLM-4-Voice** (Zhipu) | S2S voice chat, understanding + generation | 9B, popular for realtime local voice chat; **same family as Relay's default GLM models** — brand-consistent, and the most plausible future "voice persona" sidecar |
| **MGM-Omni** | S2S + voice cloning, long speech | Newer contender; long-form focus |
| **Sesame CSM / LLaMA-Omni** | S2S research line | Did not surface prominently in 2026 community comparisons; field has shifted to the Qwen3 family |
| **vLLM-Omni** | Serving layer | OpenAI-compatible speech API over these models — the integration seam if Relay ever hosts one |

### Verdict

1. Phases A–D deliver the feature; no S2S model is required for a competitive hands-free mode.
2. The **pipeline stays the agent's voice** — it is the only architecture where tools, permissions,
   and cost work unchanged.
3. A **S2S "voice persona" is a separate, additive product** (chat with a voice-first model), not a
   replacement. Moshi is the technical leader (full duplex, 200 ms) but carries WSL2 + 10–20 GB
   VRAM + CC-BY; GLM-4-Voice is the pragmatic candidate given family alignment; Qwen3-Omni is the
   one to watch as quantizations mature.
4. **Revisit trigger:** any of — a S2S model with credible function-calling over text side-channels;
   llama.cpp gaining Ultravox/Omni audio input; Kyutai shipping a Windows-friendly moshi-server.
   Until then, spend on Phases A–D which improve *both* dictation and read-aloud regardless.

---

## 8. Phased plan

| Phase | Deliverable | Effort | Risk |
|---|---|---|---|
| **A — Barge-in v1** | Mic VAD (Silero via sherpa crate) active during read-aloud; interrupt = cancel sentence queue + LLM stream; headphones clean path + speaker ducking fallback; 250 ms confirm window | S (2–4 d) | Low — all primitives exist; main risk is VAD tuning on real speakers |
| **B — Streaming STT** | Streaming zipformer partials (200–300 ms cadence, no 20 s ceiling), whisper stays the commit pass, Silero replaces energy endpointing; hands-free endpointing (pause = turn yield) | M (3–5 d) | Medium — new model catalog entries + download plumbing; CPU budget shared with TTS |
| **C — Streaming TTS** | Progress-callback synthesis emitting audio chunks; first-chunk sentence splitting; synthesis/playback pipelining | M (3–5 d) | Low-medium — callback shape in sherpa-sys is raw; WAV-cache keying must be reworked per-chunk |
| **D — Voice session UX** | Continuous loop state machine (listening/thinking/speaking), mic-mode picker (PTT / hands-free / off), wake-word optional (open question — sherpa has KWS), cost lines into the dashboard, settings (§ "Voice") | M (~1 wk) | Medium — UX surface, not tech |
| **E — S2S spike** (deferred) | Time-boxed: Moshi under WSL2 on a 24 GB card; GLM-4-Voice GGUF/transformers; measure interruption realism + inner-monologue tool hook | L–XL | High — deployment tax, tool gap |

Sequencing note: A and C are independent; B's endpointing needs A's VAD work; D assembles. The
dictation experience improves as a side effect of every phase.

---

## 9. Risks & unknowns

- **CPU contention**: streaming zipformer + Kokoro + whisper + the LLM on one machine. Mitigation:
  zipformer is tiny (int8, CPU), whisper is a sidecar with a serial queue, and the GPU TTS build
  already exists; measure before promising always-on listening on low-end CPUs.
- **Windows audio session plumbing**: ScriptProcessor is deprecated in favor of AudioWorklet; the
  duplex loop should move capture to AudioWorklet while touching this code.
- **Self-interruption ghosts** on speakers even with ducking — the confirm window and Silero
  thresholds need real-room tuning; headphones-first default avoids shipping the hard problem.
- **Moshi on Windows = WSL2** — a support liability for a Windows-first app; don't ship what we
  can't install with one click (the model-market standard).
- **Latency claims are environment-dependent** — the 45 ms/200 ms numbers in external posts are
  high-end-GPU figures; set expectations at 300–500 ms first-audio locally.

---

## 10. FAQ — "After A–D, do we have voice like Claude/ChatGPT? What's still missing?"

**Short answer: A–D reproduces *Claude's* voice mode almost exactly — because Claude's voice mode
is this same pipeline, not S2S. What stays out of reach is *ChatGPT-realtime-grade* native speech,
and the blocker is model architecture, not app code.**

What the competitors actually run (verified 2026-09-30):

| Product | Architecture | Notes |
|---|---|---|
| **Claude voice mode** (mobile, and voice for Claude Code) | **STT → Claude → TTS read-aloud** — a pipeline, same shape as ours. Anthropic partnered with **ElevenLabs** (May 2025) for the TTS leg; their own Cookbook demonstrates the low-latency STT→Claude→TTS pattern. | A–D is the same design; the residual gap vs Claude is polish (turn-taking feel, latency), not category. |
| **ChatGPT Advanced Voice** | **Native S2S** — `gpt-realtime` (GA, now 2.x) is omni-modal: reasons on raw audio, owns VAD/turn-taking, speaks natively with prosody, **and supports function calling natively inside the realtime session**. | The real benchmark. Cloud-only. |
| **Gemini Live** | Native audio dialogs | Same class as ChatGPT. |

So the question splits in two:

**1. Can our current models behave like ChatGPT's voice? No — and never by wiring.** S2S is a model
architecture, not a feature: a model trained end-to-end on audio-token in/out. Everything Relay
serves today is text-native at the reasoning core — GLM/cloud text models and local GGUFs take text
in and emit text out; whisper is audio→text; Kokoro is text→audio. No amount of piping changes
what the core model perceives. The audio-native models exist (Qwen3-Omni, GLM-4-Voice, Moshi) but
in 2026 they are heavy, Linux-oriented to serve, and (open ones) cannot call tools credibly — the
one closed stack that can (OpenAI Realtime) is cloud, which collides with local-first.

**2. Does the *experience* still approach ChatGPT? Mostly yes, with four honest deltas:**

| Dimension | Native S2S (ChatGPT) | Our pipeline after A–D | Can we close it? |
|---|---|---|---|
| Round-trip latency | ~250–400 ms end-to-end | ~0.7–1.2 s realistic local (sum of legs) | Each leg improves independently; GPU TTS + zipformer partials get first audio well under 1 s |
| Prosody / emotion in speech | Natively generated (laughs, hesitation, pacing) | Kokoro reads text well but flat affect | Partially — expressive markup/voice blending; never fully, until an audio-native decoder |
| Turn-taking | Semantic — knows a thought is unfinished mid-pause | Acoustic VAD (silence = done) | **Yes, largely** — "semantic VAD": feed the partial transcript to a cheap LLM call that rules "complete?" before ending the turn (Phase D enhancement) |
| Hearing tone/hesitation | Native | Lost at transcription | Only via audio-aware input models (Ultravox-class); low value for a coding agent |

For **a coding-agent shell**, the deltas that matter most are latency and turn-taking — and both
are pipeline-fixable. Emotional prosody, the most audible difference, matters least when the
answer is a diff summary.

One more consequence worth stating: because the Phase-D loop is engine-agnostic (a state machine
over listening/thinking/speaking), the same UX can later host **an OpenAI Realtime session as an
alternative engine** — its native function calling would map onto Relay's tool layer, giving
ChatGPT-grade voice for users who accept cloud — **or** a local S2S model when one matures, without
redesigning either. Building A–D is what makes both futures plug-compatible.

---

## 11. Sources

**Internal (code-verified 2026-09-30):** `src/lib/voiceDictationCore.ts`, `src/lib/tts.ts`,
`src/hooks/useTtsAutoRead.ts`, `src-tauri/src/commands/tts.rs`, `tts_gpu.rs`, `speech.rs`,
`build_updates.rs`, `sherpa-onnx-sys 1.13.8` vendored crate (TTS progress callback surface),
`docs/research/TTS_FEATURE_RESEARCH.md`.

**External (Sept 2026):**
- Moshi: [kyutai-labs/moshi](https://github.com/kyutai-labs/moshi) (160 ms theoretical / ~200 ms
  practical on L4; moshi-server; CC-BY 4.0 weights), [arXiv 2410.00037](https://arxiv.org/html/2410.00037v2)
  (DSM, Inner Monologue), [Kyutai STT](https://kyutai.org/stt/),
  [release blog](https://kyutai.org/blog/2024-09-18-moshi-release/)
- Ultravox: [fixie-ai/ultravox](https://github.com/fixie-ai/ultravox),
  [ultravox.ai](https://www.ultravox.ai) (TTFT ~400 ms, 50–80 tok/s, vLLM path; no 2026 llama.cpp support found)
- Streaming ASR: [Moonshine Voice](https://github.com/usefulsensors/moonshine) (v2 ergodic streaming
  encoder), [Kyutai STT](https://kyutai.org), [AssemblyAI open-source STT comparison (Aug 2026)](https://www.assemblyai.com),
  [Gladia model guide](https://www.gladia.io)
- Kokoro streaming: [Kokoro vs XTTS-v2 latency (Apr 2026)](https://gigagpu.com),
  [FlashTTS paper (arXiv Jun 2026)](https://arxiv.org),
  [kokoro-wyoming streaming (HA community, Sep 2026)](https://community.home-assistant.io),
  [kokoro-js chunking](https://github.com), [self-hosted CPU guide](https://blog.nemesisnet.co.za)
- Barge-in/AEC: [RunEdge on-device barge-in](https://www.runedge.ai/blog/barge-in-interruption-handling-on-device-voice),
  [FutureAGI barge-in & turn-taking 2026](https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/),
  [Coval echo cancellation guide](https://www.coval.ai/blog/voice-ai-echo-cancellation/),
  [WebRTC AEC3 explained](https://switchboard.audio/hub/acoustic-echo-cancellation-how-webrtc-aec3-works/),
  [AEC barge-in technical (NER > 0 dB)](https://vocal.com/echo-cancellation/aec-barge-in/)
- S2S field: [HN: best local/open S2S (2026)](https://news.ycombinator.com/item?id=46731068),
  [Qwen3-Omni discussion #30](https://github.com/QwenLM/Qwen3-Omni/discussions/30),
  [vLLM-Omni speech API](https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/speech_api/),
  [MGM-Omni (r/LocalLLaMA)](https://www.reddit.com/r/LocalLLaMA/comments/1nu3slg/)
