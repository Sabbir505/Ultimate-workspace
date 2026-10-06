# Agent findings: commands media/AI (image_gen, local_model_market, tts, tts_gpu, stt, speech, llama_build)
# Status: COMPLETE — verified result captured 2026-10-02 (only agent of wave 1-5 to finish before quota cap)

FILES COVERED: src-tauri/src/commands/image_gen.rs, local_model_market.rs, tts.rs, tts_gpu.rs, stt.rs, speech.rs, llama_build.rs (all read in full).

## P0

**1. stt.rs — whisper-server sidecar's piped stdout/stderr are never drained: the server wedges permanently once the OS pipe buffer fills.**
`stt.rs:433-435` spawns the child with `.stdout(Stdio::piped())` / `.stderr(Stdio::piped())`, and the `SttHandle` stored at `stt.rs:474-478` keeps the `Child` but no reader task is ever spawned; `stop_sidecar` (`stt.rs:548-554`) only kills it. whisper.cpp prints its per-inference timing table to stdout on every `/inference` request (and `speech.rs` fires repeated "partial" live transcriptions while the user dictates), so after roughly a hundred clips the ~4-64 KB pipe buffer fills and the child blocks inside `printf` — every subsequent transcription hangs until the 120 s timeout. The codebase itself documents this exact failure mode and fix in image_gen.rs (`image_gen.rs:1365-1371`; fixed there by `spawn_sidecar_readers`, `image_gen.rs:1422-1442`). Fix: reuse the image_gen pattern — `child.stdout.take()` / `child.stderr.take()` and pump both to a log file (or `Stdio::null()`).

## P1

**2. image_gen.rs — the startup warmup render bypasses `GENERATE_GATE`, so it can run concurrently with a real generation, which (per the module's own contract) hangs both clients.**
`image_gen.rs:1101-1105`: "One image at a time — sd-server has no queue or cancellation, so a second concurrent generation would just hang both clients." Every real path takes the gate (`generate_once` `image_gen.rs:1497`, `generate_via_app` `image_gen.rs:1700`), but the warmup task spawned in `start_sidecar_core` (`image_gen.rs:1344-1356`) calls `post_generation(port, "warmup", ...)` directly (`image_gen.rs:1352`) with no gate. Trigger: user presses Start (warm=true; GPU JIT makes the warmup run 30-60 s), then generates — two concurrent POSTs to a server with no queue; both hang toward the 30-minute client timeout (`image_gen.rs:1787`). Secondary effect: while warmup runs, `WARMING` is true, so the real generation's step events are suppressed (`image_gen.rs:1406-1408`) and the UI shows no progress. Fix: warmup should acquire `GENERATE_GATE` (fire-and-forget task, so waiting does not delay the start command's return).

**3. local_model_market.rs / image_gen.rs — image-model downloads pass `expected_sha256: None`, so multi-GB downloads have no integrity check and the "retrying resumes" promise is false: retry deletes the partial and restarts from byte 0.**
`run_download` only resumes a leftover partial when a hash is available — `local_model_market.rs:1347-1352`: `let can_resume = if expected_sha.is_some() { ... } else { false };` — and otherwise discards it (`local_model_market.rs:1353-1358`). Yet the exhausted-retries error tells the user the opposite — `local_model_market.rs:1570-1573`: "download interrupted ({why}) after {DOWNLOAD_ATTEMPTS} attempts — the bytes already fetched are kept, so retrying resumes". All three image-gen call sites pass `None` (`image_gen.rs:2437`, `2526`, `2552`), and `ImageModelInfo` (`image_gen.rs:154-182`) has no `sha256` field at all, so the 3.1-6.9 GB catalog weights are never verified and always restart from zero after a failure. Fix: add `sha256` (+ optionally `size_bytes`) to `ImageModelInfo` for pinned catalog files and pass it through `start_model_download_inner`; or make the meta-file identity check sufficient for resume when a post-completion size check exists.

## P2

**4. image_gen.rs — `resolve_binary` can return a non-existent binary, shadowing working managed builds.**
`image_gen.rs:829-835`: a settings/env override that is a *directory* pushes `path.join(SD_SERVER_EXE)` without checking existence, and selection is `candidates.into_iter().next()` (`image_gen.rs:879`) — first match wins, existent or not. A stale `imageGen.sdServerPath` pointing at a folder without `sd-server.exe` makes every start fail while a healthy managed install sits unused. Contrast `stt.rs:262` which correctly ends with `.find(|p| p.is_file())`. Fix: `candidates.into_iter().find(|(p, _)| p.is_file())`.

**5. image_gen.rs — `image_gen_install` only stops a running server when `force`, violating its own invariant on the cudart-repair path.**
`image_gen.rs:2682-2690`: the cudart-repair condition triggers reinstall, but `if force { stop_sidecar(&image).await; }` means the repair path (force=false, exe exists) re-extracts over an `sd-server.exe` Windows may hold locked; repair fails opaquely. Compare `stt_install_server` (`stt.rs:874-877`) which stops whenever `exe_path.is_file()` inside the reinstall branch. Fix: `if force || exe_path.is_file() { stop_sidecar(&image).await; }`.

**6. stt.rs / image_gen.rs — `stop_sidecar` is not serialized with `START_SEQ`: a stop issued during a start silently no-ops and the newly spawned server keeps running.**
`stop_sidecar` (`stt.rs:548-554`, `image_gen.rs:1477-1482`) does `stt.0.lock().take()` — during the up-to-10 s (stt) / 120 s (image_gen) health poll the state is still `None`, so stop returns having killed nothing; `start_sidecar_core` then inserts its handle (`stt.rs:474`, `image_gen.rs:1312`) and the server runs despite the user's stop. Fix: take `START_SEQ` in the stop paths (or re-check/clear state at the end of the start sequence under both locks).

**7. tts_gpu.rs — `synthesize_gpu` waits on the CUDA child with no timeout; a wedged engine hangs `tts_speak` indefinitely.**
`tts_gpu.rs:676-679`: unbounded `cmd.output().await` (the 1800 s timeout only bounds HTTP downloads, not this child). A driver-level hang leaves every GPU read-aloud pending forever; the temp WAV also leaks on that path. Fix: wrap in `tokio::time::timeout` (e.g. 5-10 min) and kill the child + remove `out` on expiry.

**8. tts.rs — the 377-file Kokoro bundle install has no integrity verification; completion/skip is by size only.**
`hf_download_file` (`tts.rs:1417-1469`) downloads with no SHA check; resume-skip (`tts.rs:1429`) is pure size equality — a corrupted or wrong-revision file of the right length is treated as complete, surfacing later as opaque "download may be corrupt" engine-load errors. Every other downloaded artifact in scope is SHA-verified. Fix: fetch the HF tree with `?expand[]=lfs` and verify hashes, or at least the largest files (model.onnx, voices.bin).

**9. tts.rs — `tts_install_model` inserts its registry slot without an in-progress guard, orphaning the first install's cancel sender.**
`tts.rs:1527-1531`: `registry.active.lock().insert(...)` — unlike `start_model_download_inner` (`local_model_market.rs:1047-1052`, which refuses "download already in progress"), a double-click on Install overwrites the slot, so Cancel cancels nothing while the first install keeps running; both installs also write the same files concurrently. `tts_install_gpu` and `image_gen_install` have no concurrency guard at all. Fix: mirror the `contains_key` check-and-refuse under the lock.

**10. local_model_market.rs — cancel followed by an immediate retry can race two tasks onto the same `.partial` file.**
`cancel_model_download` (`local_model_market.rs:1615-1620`) removes the slot and fires the oneshot; a retry instantly passes the guard and starts writing the partial, while the old task's cancel path still executes `fs::remove_file(partial_path)` (`local_model_market.rs:1545-1547`) — deleting the new download's file out from under it. Fix: leave the slot in the registry until the spawned task's own cleanup removes it (cancel only signals), or key new downloads to a fresh partial name.

**11. tts.rs — synthesis cache writes are non-atomic, so a crash mid-write poisons the cache with a truncated WAV that is served forever.**
`tts.rs:945` and `tts.rs:959`: `std::fs::write(&cached_path, &bytes)` writes the final cache path in place; a crash mid-write leaves `<key>.wav` truncated, and the next `tts_speak` for that sentence returns it as `cached: true` (`tts.rs:935-937`) with broken playback until the 512 MB cap evicts it. Fix: write `{key}.tmp` then `fs::rename`.

**12. image_gen.rs / tts.rs — heavy synchronous directory walks run directly on the async runtime.**
`image_gen_status` (`image_gen.rs:1032-1042`) runs `scan_detected` (full models-tree walk + GGUF header sniffing, `image_gen.rs:701-781`) plus `find_installed` once per catalog entry (nine more full-tree walks) — all blocking `std::fs` inside `async fn` (the file's own comment: "on a large/network models folder they take seconds", `image_gen.rs:1019-1022`). `status_inner` → `manual_models` → `dir_size` (`tts.rs:1178-1181`, `227-244`) and `cache_bytes` (`tts.rs:1200`, `822-833`) do the same. This stalls a tokio worker per status call. Fix: wrap in `tokio::task::spawn_blocking`, and/or build the tree index once per status call.

**13. llama_build.rs — an install that failed the CUDA-DLL check is unrecoverable without the buried force flag; the second Install click silently "succeeds" against a CPU-falling-back build.**
`llama_build.rs:105`: `let fresh = force || !exe_path.is_file();` — `require_cuda_runtime_dlls` (`llama_build.rs:129`) only runs inside `if fresh`. After one failed attempt the exe exists, so a non-force retry skips verification, points `LLAMA_SERVER_PATH_KEY` at the managed build, and emits `Done` (`llama_build.rs:138-155`). Fix: add `|| !cuda_runtime_dlls_present(&install_dir)` to `fresh`.

**14. stt.rs — the 10-second health-poll budget is likely too short for the largest catalog model on slow disks.**
`stt.rs:457-463`: `for _ in 0..40 { sleep(250ms) }` = 10 s total before the child is killed with "never became reachable". `ggml-large-v3-turbo-q5_0` is 547 MB (`stt.rs:88-95`); loading from HDD/USB (plus AV scanning) can exceed 10 s. The image-gen poll allows 120 s with the same rationale (`image_gen.rs:1278-1286`). Fix: raise the budget (60-120 s) and `try_wait` inside the loop to fail fast.

**15. DRY within scope.**
(a) `image_gen_use_family` has three near-identical `start_model_download_inner` dispatch blocks (`image_gen.rs:2419-2441`, `2493-2529`, `2531-2556`) — extract one `queue_download(info)` helper. (b) `download_mmproj` (`local_model_market.rs:1752-1859`) hand-duplicates the filename sanitizer (`1164-1171` vs `1774-1782`), partial/meta path setup, spawn + registry cleanup from `start_model_download_inner` (`1181-1253` vs `1806-1845`). (c) `pick_free_port` duplicated verbatim (`stt.rs:360-366`, `image_gen.rs:990-996`). (d) cudart-prefix scan exists twice: `missing_cudart_prefixes` (`image_gen.rs:2625-2643`) vs `require_cuda_runtime_dlls` inline filter (`llama_build.rs:170-182`), already diverging in message/behavior.
