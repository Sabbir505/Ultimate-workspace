---
name: pptx
description: "Use this skill whenever generating a slide deck/presentation (.pptx) in Conduit's Chat tab sandbox. Triggers: any request for a deck, slides, pitch deck, or presentation deliverable."
---

# PPTX Generation (python-pptx)

`python-pptx` is preinstalled in the sandbox. This library requires more manual layout work than Word generation does — every text box, shape, and image needs explicit position and size. Budget for that.

## Set the canvas size first

```python
from pptx import Presentation
from pptx.util import Inches
prs = Presentation()
prs.slide_width = Inches(13.333)   # 16:9 widescreen — set this before adding slides
prs.slide_height = Inches(7.5)
```
The python-pptx default is 4:3 (10" × 7.5"). Almost nobody wants that in 2026 — set 16:9 explicitly unless told otherwise.

## Core gotchas

- **Coordinates are absolute, top-left origin, in EMU** (`Inches()`/`Pt()`/`Cm()` helpers convert for you) — nothing auto-flows or wraps into position. Plan each slide's layout in inches on paper/mentally before placing shapes.
- **Text boxes have internal default margins** — if you need text to align flush with a shape or line at the same x-coordinate, set `text_frame.margin_left = 0` (and other margins as needed) explicitly.
- **Never insert a literal bullet character.** Use paragraph-level bullet formatting via the XML (`pPr` bullet properties) — python-pptx doesn't expose bullets as a simple property, so either use a slide layout's built-in placeholder (which already has bullets defined) or set the low-level XML. Do not fake bullets with `"• " + text`.
- **One `Presentation()` per output file** — don't reuse an instance across unrelated decks.
- **Font size and boldness must be set explicitly per run** (`run.font.size = Pt(18)`, `run.font.bold = True`) — python-pptx doesn't inherit theme sizing reliably for text placed outside a layout's native placeholders.
- **Images**: `slide.shapes.add_picture(path, left, top, width=..., height=...)` — always pass explicit width AND height, or the aspect ratio can distort if only one is given inconsistently with the source image. Check the image's actual dimensions before placing to avoid stretching.
- **Charts**: use `slide.shapes.add_chart()` with native chart types (`XL_CHART_TYPE.COLUMN_CLUSTERED`, etc.) for anything PowerPoint can chart natively — don't render a chart as a static image if a native chart type covers it; native charts stay editable and look correct at any zoom level.
- **Speaker notes** go via `slide.notes_slide.notes_text_frame.text = "..."` — never as a visible text box on the slide itself.

## Design rules — apply these strictly, this is where generated decks usually fail

- **Titles need real size contrast**: 36pt+ for titles vs. 14-18pt for body text. Weak contrast is the most common "obviously AI-made" tell.
- **Never use an accent line/underline under titles** — this is one of the clearest visual signatures of AI-generated slides. Use whitespace or a background tint for separation instead.
- **Never add decorative color bars or accent stripes** — no full-width header/footer bars, no vertical sidebar stripes, no thin accent edges on cards. These read as filler, not design.
- **Don't default to cream/beige backgrounds.** Use white or the project's actual brand palette (for you: void black / ion purple / plasma cyan, when the deck is Conduit-branded).
- **Don't build text-only slides.** Every slide should have some non-text visual element — an icon, a chart, an image, a diagram — plain title-plus-bullets on every slide reads as minimum-effort.
- **Maintain consistent spacing** — pick one gap unit (0.3" or 0.5") and use it uniformly across all slides; don't let spacing vary slide to slide.
- **Never let text overflow its box.** If content doesn't fit, reduce the font, trim the copy, or split across two slides — don't ship clipped text.
- **Keep margins ≥ 0.5" from every slide edge**, and ≥ 0.3" between adjacent elements — cramped layouts are the second most common visible defect after overflow.

## QA — required before calling a deck done

**Content check** — dump the text and scan for leftover placeholders, typos, or wrong ordering:
```bash
python -c "from pptx import Presentation; [print(s.shapes.title.text if s.shapes.title else '') for s in Presentation('output.pptx').slides]"
```

**Visual check** — render every slide to an image and actually look at each one, not just the code that generated them:
```bash
soffice --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
ls slide-*.jpg   # inspect all of these before declaring the deck done
```

Look specifically for: text cut off at a box/slide edge (check this first, it's the most common defect), overlapping elements, low-contrast text (light text on light backgrounds), uneven gaps between elements, misaligned columns, leftover template placeholder text.

## Dependencies

`python-pptx` (pip) · LibreOffice (`soffice`, for PDF-conversion verification) · `pdftoppm` (Poppler, for rendering verification images)
