# Relay 0.6 — Promo Film "Quiet Machine" — Production Kit

30-second atmospheric brand film for the 0.6.0 release. Concept: Relay as a
finely-made instrument in a dark room — light, dust, craft, and a machine that is
already working. No people. No hype. One whispered line at most.

## 1. Snapshot

| Item | Decision |
|---|---|
| Length | 30.00 s (720 frames @ 24 fps) |
| Master format | 3840×2160, 24.000 fps, ProRes 422 HQ (archive) + H.264 100 Mbps (delivery) |
| Social cut | 1080×1920 9:16 re-crop + burned captions |
| Message | The workspace is a quiet instrument. Your agents, your models, your machine. |
| End line | "Your agents. Your models. Your machine." (plus `relay.` and a Windows CTA) |
| Tone | Premium product-film. Calm. Tactile. Nothing snaps except the wordmark. |
| VO | None by default. Optional single whisper (see §7). |
| Music | Minimal cinematic ambient, 70 BPM pulse enters mid-film (see §8). |
| Product truth | Every frame with readable text is a REAL screen capture. AI never draws the UI. |

Featured 0.6 pillars, in order of screen time: **Vault** (note typing, wikilinks,
graph, `#architecture` search), **local image generation** (the fox at dawn),
**event-triggered automations** (webhook fires → "Ran"), **cost hero** ("Saved $X
by prompt caching"), **live tool rows** texture in the wide shot, and the app's own
**boot splash** as the climax.

---

## 2. Style bible

Locked look — every AI generation must feel like it was shot the same night, with
the same lens, in the same room.

- Palette: charcoal near-black `#181818`/`#0d0d0d`, warm amber highlights
  (`#f59e0b → #ffb347`), cyan accents (`#88C0D0`) as the only cool light.
- Light: one warm tungsten key (camera-left), faint cyan rim/screen spill, deep
  falloff to black. No fill, no daylight.
- Optics: 35 mm anamorphic, f/1.4–f/2, shallow DOF, creamy bokeh, fine 35 mm grain.
- Motion: slow, deliberate, slider-like. No handheld, no shake, no whip pans.
- Forbidden: people, faces, hands, text, letters, logos, UI, watermarks, saturated
  color, stock-tech clichés (blue network globes, binary rain, robot hands).
- Motif: **dust motes in light** are the connective tissue — they open the film,
  reappear over the first UI insert, and return just before the fade to black.

### STYLE-BASE — prepend to every AI prompt

```
Shot on 35mm anamorphic film, f/1.4-f/2 shallow depth of field, fine film grain,
cinematic. One warm tungsten key light and a faint cool cyan rim light. Near-black
charcoal environment. Palette locked to charcoal, warm amber highlights, cyan
accents. Quiet, contemplative, premium product-film mood. Slow deliberate camera
movement, no cuts. Negative: no people, no faces, no hands, no text, no letters,
no logos, no UI, no watermarks, no bright saturated colors, no fast motion,
no camera shake, no handheld.
```

Generate 4–6 variants per shot, keep the winner's seed/first frame, and when two
shots need to feel continuous, feed the previous shot's final frame as the
image-to-video start frame.

**Tool assignment**

| Job | Tool |
|---|---|
| Atmosphere shots, ambience audio | Veo 3 (5–8 s) |
| Macro detail / abstract | Kling 2.x |
| Room wide, alternate | Runway Gen-4 |
| Styleframes, stills | Flux / Midjourney |
| Upscale to 4K | Topaz Video AI |
| VO | ElevenLabs |
| Music | Suno / Udio (or licensed bed) |
| Composite / grade | After Effects + DaVinci Resolve |

Strip any music the video model invents — keep its ambience at most.

---

## 3. Master timeline

| # | Time | Dur | Shot | Type |
|---|---|---|---|---|
| S01 | 00:00.0–00:05.0 | 5.0 | Dust in the light beam | AI plate (Veo 3 / Kling) |
| S02 | 00:05.0–00:08.0 | 3.0 | The note writes itself | Screen capture + dust overlay |
| S03 | 00:08.0–00:10.0 | 2.0 | Noise becomes an image | AI abstract plate → real fox PNG |
| S04 | 00:10.0–00:16.0 | 6.0 | The room — panes light up | AI room plate + composited capture |
| S05 | 00:16.0–00:19.0 | 3.0 | Vault graph blooms | Screen capture |
| S06 | 00:19.0–00:20.5 | 1.5 | Automation fires | Screen capture |
| S07 | 00:20.5–00:22.0 | 1.5 | Cost hero | Screen capture |
| S08 | 00:22.0–00:23.0 | 1.0 | The zoomie | Screen capture (60 fps) |
| S09 | 00:23.0–00:27.0 | 4.0 | Wordmark reveal | Motion graphics (rebuilt splash) |
| S10 | 00:27.0–00:30.0 | 3.0 | End card | Motion graphics |

Total: 30.0 s. Keep this grid — the sound design is built on it.

---

## 4. Shot list

### S01 — Dust in the light beam (0:00–0:05, AI)

Cold open. The film's first breath: nothing but light, dust, and a hum.

- **Prompt (Veo 3 / Kling):**

```
[STYLE-BASE]
Extreme macro close-up of fine dust motes drifting slowly through a single beam of
warm tungsten light that falls diagonally across a matte black desk surface. The
motes sparkle like tiny stars against near-black surroundings; extremely shallow
depth of field, soft creamy bokeh, visible film grain. Camera: very slow, steady
push-in on a slider, about 10% of frame over 5 seconds. Ambience: quiet room tone
with a faint low electrical hum.
```

- **Post:** Fade from black over 0.6 s. Hold the final 6 frames and cross-dissolve
  into S02. Sample a 1-second clean patch of the moving dust — it becomes the
  overlay used in S02 and S09.

### S02 — The note writes itself (0:05–0:08, capture + overlay)

First look at the product, but photographed, not pasted: the Vault writing a real
note, with the dust still drifting across the glass.

- **Capture:** Vault editor, note titled `Memory design.md`. Type slowly
  (~2–3 chars/sec) so text reads on camera; place two `[[wikilinks]]` (e.g.
  `[[Session Mesh]]`, `[[Compaction]]`) so they light cyan as they link. Catch the
  tag line `#memory #architecture`.
- **Composite:** 2–3% scale push on the capture. Overlay the S01 dust patch at
  15–25% in Add/Screen so the room feels continuous. Add a soft cyan bloom on the
  wikilinks only (Glow, threshold high — nothing else in the frame blooms).
- **Sound:** the first piano note lands here (see §8), plus close, dry key
  foley (recorded or from a foley library — not the OS keyboard sound).

### S03 — Noise becomes an image (0:08–0:10, AI plate → real PNG)

The local image generator, dramatized. AI provides the abstraction; the product
provides the payoff.

- **AI plate (Kling / Veo):**

```
[STYLE-BASE]
Abstract macro on pure black: fine monochrome static noise slowly condensing and
settling into soft organic forms, like silver particles drifting into place in
liquid. Movement is extremely subtle and continuous until the frame is a calm
field of soft gray shapes with a faint warm amber glow at the edges. Shallow
depth of field, film grain, mesmerizing, quiet. No recognizable subject, no text.
```

- **Payoff:** cross-dissolve (12 frames, soft-light) into the REAL generated fox
  PNG from the app, with a 3% push and a gentle bloom. If the app's image panel
  renders progressive previews, capture that sequence instead — it is even better.
- **Truth source:** use the actual sample prompt from `fox_uri.txt` ("a yellow fox
  curled up on mossy ground at dawn, soft mist, cinematic lighting") so the promo
  matches the shipped output.

### S04 — The room, and the panes light up (0:10–0:16, AI + composite + MG)

The widest shot in the film and the emotional turn: the instrument is the whole
desk, and it is full of work.

- **AI room plate (Veo 3 / Runway):**

```
[STYLE-BASE]
Wide cinematic product-film shot of a dark, minimal home office at night, camera
behind the desk at a low three-quarter angle. An open laptop sits on a dark wood
desk; its screen glows softly with a diffuse cool cyan light that spills across
the desk and onto the wall behind it. The screen surface is a soft featureless
glow with no readable content. A single warm tungsten floor lamp is barely lit in
the deep background; everything else falls into near-black shadow. Camera: slow,
steady dolly-in toward the laptop over 6 seconds. Ambience: quiet night room
tone, faint hum.
```

- **Composite recipe:**
  1. Corner-pin the real six-pane capture onto the laptop screen with perspective
     warp; set blend to Screen; add Bloom + slight Glow so it looks photographed.
  2. Duplicate the capture, heavy blur, gradient-masked over the desk and wall,
     low opacity (fake screen spill).
  3. Reveal effect: start the capture at ~35% brightness and unmask each of the
     six panes with soft-edged animated masks, 150 ms apart starting at 0:13.0,
     each with a brief cyan bloom flash — six small windows turning on, one by one.
  4. This is where the 0.6 **live tool rows** earn their keep: let one pane be
     mid-turn with the shimmering tool title and latest-call badge.
  5. Overlay the S01 dust patch at 12% on top of everything.
- **Sound:** six soft glints (tiny glass ticks) land with the six lights.

### S05 — Vault graph blooms (0:16–0:19, capture)

- **Capture:** Vault graph view. Record it settling into layout; if the app's
  layout is instant, capture the real node positions and animate only a gentle
  4–6% push plus a soft focus-pull (defocus → sharp) in AE. Keep node positions
  real — no invented physics.
- **Second beat:** type `#architecture` in search; two or three notes highlight.
- **Sound:** a soft click on each node landing; the music pulse (70 BPM) starts
  here, and these clicks are its first beats.

### S06 — Automation fires (0:19–0:20.5, capture)

- **Capture:** the Automations view with the trigger picker visible (webhook /
  file / git HEAD / Gmail), then the card flipping to "Ran". Fire the trigger for
  real — `curl` the loopback `/trigger/<id>/<secret>` URL so the pulse animation
  is authentic.
- **Composite:** 0.5 s cyan bloom on the card when it flips.
- **Sound:** a soft, low "stamp" — this is the release's headline feature; give it
  the most satisfying single sound in the film.

### S07 — Cost hero (0:20.5–0:22, capture)

- **Capture:** the Cost dashboard headline reading "Saved $X by prompt caching"
  with the cached-input share visible. Use your real demo-session number — do not
  fabricate a dramatic figure; a modest honest number is more credible.
- **Composite:** push in 5%; let the number land on a musical beat.
- **Sound:** a subtle tick, brighter than S06.

### S08 — The zoomie (0:22–0:23, capture)

- **Capture:** 1 second of the pet doing zoomies across the composer (record at
  60 fps and conform). Cat "Mochi" reads best on camera. If the real app is hard
  to control for this, use `pet-harness.html` for a clean isolated capture.
- **Sound:** one small, tasteful 8-bit blip — the film's only "cute" sound.
  It is also the last sound before the climax, so keep it quiet.

### S09 — Wordmark reveal (0:23–0:27, motion graphics)

Fade the picture to black over 0.45 s starting at 0:23.0, then replay the app's
REAL boot choreography, rebuilt at 4K from the shipped keyframes
(`index.html:14–141` — these are the actual values, keep them):

| Element | Spec |
|---|---|
| Background | `#181818`, fade in with the cut |
| Logo | `public/logo.png`, 96 px in-app → 384 px at 4K; pop from scale 0.82 + opacity 0 over 0.7 s, `cubic-bezier(0.2, 0.9, 0.3, 1.2)` (overshoot) |
| Wordmark | "RELAY" (uppercase via CSS), Space Grotesk Bold 700, tracking 0.16 em, color `#f5efe6`; scale 30 px in-app proportionally to the 4K logo (~120–160 px) |
| Letter reveal | each letter rises 12 px → 0, opacity 0 → 1, over 0.4 s, `cubic-bezier(0.2, 0.9, 0.3, 1)`; delay = 0.25 s + index × 0.09 s (R .25 / E .34 / L .43 / A .52 / Y .61) |
| Progress bar | track 128×2 px → 512×8 px at 4K, radius 2 px, `rgba(255,255,255,0.08)`, fades in 0.5 s at the 0.6 s mark |
| Bar fill | gradient 90° `#f59e0b → #ffb347`, scaleX 0 → 1 over 1.7 s, `cubic-bezier(0.3, 0, 0.4, 1)`, starting 0.6 s after element start |

Timing in the film: elements start at 0:23.4; bar completes ≈ 0:26.2; hold the
finished lockup to 0:27.0.

- **Sound:** reverse-swell into a low boom on the logo pop (0:23.4); the softest
  sparkle per letter; a warm, satisfying "done" tick the instant the amber bar
  completes. This moment is the film's loudest — and it is still quiet.
- **Alternatively:** capture the real splash by recording the app launching at
  60 fps — use it as reference for the rebuild, or as-is if the capture is clean.

### S10 — End card (0:27–0:30, motion graphics)

- Black holds. Centered stack, Space Grotesk:
  1. "Your agents. Your models. Your machine." — Medium 500, `#e4e4e4`,
     ~72 px @ 4K, tracking 0.02 em, fade in 0.8 s at 0:27.0.
  2. `relay.` — Bold 700, white, with the period in cyan `#88C0D0` (matches the
     site header mark), fades in at 0:27.6.
  3. "Built for Windows" — Space Mono, ~28 px, tracking 0.14 em, 60% white,
     fades in at 0:28.2. For social cuts, swap this line for the download URL.
- **Sound:** pad holds; fade audio out over the last 0.5 s, ending on air, not a
  hard cut.

---

## 5. Screen capture checklist

Record at 2560×1440 minimum (3840×2160 preferred), 60 fps, high bitrate
(OBS, hardware encoder, CQP 18). Dark theme, default Space Grotesk, UI scale that
keeps text readable on video (test a frame at 50% size before committing).

**Prepare a demo world first — nothing real may appear on camera:**

- Demo project folder (e.g. `D:\demo\aurora-board`) as the working folder.
- Demo vault `~/Documents/Relay/demo-notes` with 8–12 notes, including
  `Memory design.md`, `Session mesh.md`, `Compaction.md`, linked with wikilinks.
- Sidebar with only demo chats/artifacts; notification center empty; no personal
  paths, real names, emails, or API keys anywhere.
- Costs driven by the demo session — the S07 number comes from real demo usage.
- OS: hide clock/widgets, silence notifications, disable update toasts.

| # | Capture | Used in | Notes |
|---|---|---|---|
| C1 | App launch splash | S09 reference | Record 60 fps; may be replaced by the 4K rebuild |
| C2 | Vault note typing + wikilinks | S02 | Slow typing, 2 `[[links]]`, tag line visible |
| C3 | Vault graph settling + `#architecture` search | S05 | Keep real node layout |
| C4 | Image generation: prompt → fox PNG | S03 | Use the exact prompt from `fox_uri.txt` |
| C5 | Automations: trigger picker → card flips to "Ran" | S06 | Fire via the real loopback webhook URL |
| C6 | Cost hero: "Saved $X by prompt caching" | S07 | Honest demo number |
| C7 | Six-pane workspace, one pane mid-turn with live tool rows | S04 | The composited element |
| C8 | Pet zoomie | S08 | 60 fps; `pet-harness.html` if needed for a clean take |

Cursor discipline: move slowly and deliberately; if the pointer reads nervous,
post-smooth it (Cursorful / PointerFocus) or add motion blur in AE.

---

## 6. AI generation plan

| Shot | Model | Aspect | Length | Variants | Notes |
|---|---|---|---|---|---|
| S01 | Veo 3 (audio on) or Kling 2.x | 16:9 | 5 s | 6 | Keep ambience, discard any music |
| S03 | Kling 2.x | 16:9 | 2–4 s | 6 | Ends on a calm field; blend to the PNG |
| S04 | Veo 3 or Runway Gen-4 | 16:9 | 6–8 s | 8 | Screen must stay featureless — no UI |

Upscale plates to 4K with Topaz before compositing. Keep every winning generation
and its first/last frames in `docs/notes/`-adjacent working storage so the film can
be re-cut later without regenerating.

---

## 7. Voiceover

**Variant A (recommended): no VO.** The film is music, foley, and type. This is
what makes it read "premium brand film" instead of "ad".

**Variant B: one whispered line**, entering at 0:23.2 over the fade to black,
delivered slowly, almost to the speaker themself:

- Primary: *"One window. Everything you build."*
- Alternate 1: *"The quiet machine."*
- Alternate 2: *"Your agents. Your models. Your machine."* (read over the end card
  — use for social cuts where the visual type is smaller)

**ElevenLabs direction:** documentary-narrator archetype, low register, intimate,
no announcer energy, pace ~130 wpm delivered slower than that. Stability 60–65,
Similarity 75–85, Style 10–20, Speaker Boost on, 48 kHz render. Post: high-pass at
80 Hz, gentle de-ess, short plate tail (0.8 s) so the whisper sits in the room;
duck music 3–4 dB under it.

---

## 8. Music and sound design

**Music brief (Suno / Udio, instrumental):**

```
Minimal cinematic ambient score, 30 seconds. Opens with a low sub drone and airy
room texture. Sparse soft piano single notes enter around 0:05. A gentle
heartbeat-like pulse at 70 BPM starts at 0:10 and grows subtly. A slow warm swell
begins at 0:19 and resolves into a soft sustained pad with a single high
shimmering note at 0:23. Ends cleanly, fading gently. Warm analog texture, tape
hiss, contemplative, premium tech-documentary mood. No drums, no vocals, no
melody hooks. Instrumental.
```

Library alternative — search terms: "minimal piano cinematic ambient",
"quiet technology documentary", "slow build ambient piano".

**Cue sheet**

| Time | Music | Sound design |
|---|---|---|
| 0:00–0:05 | Sub drone + air | Room tone, faint hum, dust shimmer |
| 0:05–0:08 | First piano note | Keys foley (dry, close) |
| 0:08–0:10 | Rising high shimmer | Soft whoosh on the resolve to the fox |
| 0:10–0:16 | Drone deepens | Six soft glass glints as panes light (150 ms apart, from 0:13) |
| 0:16–0:23 | 70 BPM pulse in | Node clicks, automation "stamp" (the best sound in the film), cost tick, one quiet blip for the zoomie |
| 0:23–0:27 | Swell → pad | Reverse swell + low boom on logo pop; letter sparkles; "done" tick as the amber bar completes |
| 0:27–0:30 | Pad holds | Fade to air over the last 0.5 s |

**Mix:** master −14 LUFS integrated, −1 dBTP, 48 kHz stereo. Deliver two mixes —
with and without the optional whisper. Nothing in the mix should ever startle;
this film's loudest moment is the logo boom, and it is polite.

---

## 9. Edit, grade, deliver

- **Timeline:** 24.000 fps, 3840×2160. AI plates conform (native 24). UI captures
  shot at 60 fps — conform with frame blending only if a push judders; most UI
  shots are near-static, so straight conform is fine.
- **Transitions:** cross-dissolves 6–12 frames max; one hard cut in the film — the
  cut to black at 0:23.0. Everything else breathes.
- **Grade:** subtle film emulation (Kodak 2383-class, restrained). Keep blacks at
  ~`#0d0d0d`, never fully crushed; protect the cyan hue — do not let the teal
  creep into shadows; warm the highlights. Grain: 8–12% on AI plates, 4–6% on UI
  captures, matched. Light vignette on every shot.
- **Match UI to plates:** every capture gets bloom + grain + a hair of softness so
  it reads as photographed glass, not a pasted screenshot.
- **Deliverables:** 4K master (ProRes + H.264/100 Mbps), 1080p web (H.264 ~20
  Mbps), 9:16 1080×1920 re-crop (re-frame S04 and re-center S09/S10 with larger
  type; captions burned for social), audio AAC 320 kbps.

---

## 10. Reusable assets (already in the repo — do not regenerate)

| Asset | Path |
|---|---|
| Logo | `public/logo.png` (also `site/logo.png`) |
| Splash choreography (exact keyframes) | `index.html:14–141` |
| Splash hold + fade behaviour | `src/main.tsx` (~2.4 s hold, 0.45 s fade) |
| Wordmark font | Space Grotesk 700; mono: Space Mono |
| Palette | bg `#181818`, text `#e4e4e4`, cyan `#88C0D0`, amber `#f59e0b → #ffb347`, splash type `#f5efe6` |
| Fox sample + its exact prompt | `fox_uri.txt` |
| Model sample stills | `public/model-samples/*.jpg` |
| Wallpapers (glow plates, wall spill) | `public/sideart/{aurora,dusk,ember,forest,violet,waves}.jpg` |
| Pet sprites | `public/pets/{cat,axolotl,robot,hats}.png` |
| Clean capture harnesses | `pet-harness.html`, `composer-deck-harness.html` |

---

## 11. Production order

1. Build the demo world, then record C1–C8 (§5).
2. Generate and select AI plates S01/S03/S04 (§6).
3. Animatic in AE: timeline grid §3 with placeholder plates and real captures.
4. Composite S02 overlay, S03 dissolve, S04 screen integration + pane light-up.
5. Rebuild S09 at 4K from the §4 specs; build S10.
6. Music + foley pass against the exact timecodes; VO variant if wanted.
7. Grade and grain match; export the matrix in §9.

**Do not:** let AI draw the UI, use stock tech clichés, speed-ramp the edit, fake
the cost number, or add a hard-sell VO. The film works because it is quiet.

---

## Build status — motion-graphics cut (shipped)

A full 30s motion-graphics version of this film is built and rendered:
`video/quiet-machine/` (`film.html` engine, `render.mjs` capture + encode,
`audio.mjs` optional score, `README.md`). Deliverables: 4K + 1080p MP4s in
`video/quiet-machine/out/`.

Deviations from this kit, by decision:

- **Silent.** No audio track on the masters; the synthesized bed is optional and
  unused.
- **Release markers added.** `0.6` tag under the splash wordmark (25.85s), end
  card reads `RELAY 0.6 · BUILT FOR WINDOWS`, and each shipped pillar is named
  on screen with a bottom-left mono label as it appears: VAULT, LOCAL IMAGE
  GENERATION, HYBRID LOCAL SEARCH, AUTOMATION TRIGGER.
- **S01/S03/S04 are procedural stand-ins** for the Veo/Kling plates (dust field,
  block-reveal of the real fox asset, lit device with the real screenshot);
  identical timings so generated plates can be swapped in later.
- The cost figure shown is a placeholder count-up — replace with the real demo
  number before publishing.
