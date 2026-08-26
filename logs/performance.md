# Performance Log

## 2026-08-06 — Round 2: Lazy chunk splitting

**Main bundle size:** ~~1,906 KB~~ → **1,689 KB** (217 KB saved)

Lazy chunks (downloaded on demand):
- SettingsView: 28 KB (9 KB gzip)
- CostDashboard: 6 KB (2 KB gzip)
- SkillsLibrary: 8 KB (3 KB gzip)
- ArtifactPreviewPane: 173 KB
- DiffCard: 2 KB
- InlineDiagram: 1 KB
- TaskProgressCard: 1 KB

### Page-load (cold cache, vite preview :4173)

| page | domContentLoaded | FCP | total JS | total CSS | goal |
|------|------------------|-----|----------|-----------|------|
| chat | 306 ms | 364 ms | 539 KB | 33 KB | < 50 ms 🔴 |

### SPA view switches (lazy chunks)

| view | render (DOM ms) | chunk download |
|------|------------------|----------------|
| settings | 22 ms | 9 KB |
| skills | 23 ms | 3 KB |
| cost | 12 ms | 2 KB |

**Remaining bottleneck:** The main index chunk (1,689 KB / 539 KB gzip) is still huge. The 306 ms DOMContentLoaded is mostly JS parse/execute time. Need to move more heavy deps out of the initial load path.

## 2026-08-06 — Round 4: Lazy TerminalPane + BrowserPane

| metric | value | delta | goal |
|--------|-------|-------|------|
| domContentLoaded | 73 ms | -37 ms (from 110) | < 50 |
| FCP | 128 ms | -24 ms (from 152) | < 50 |
| initial JS | 223 KB | -91 KB (from 314) | |

The entry chunk is now 727 KB but only **223 KB transfers** (gzip), since
the rest is the heavy code paths that gzip well. The empty welcome screen
loads 1 JS file (the entry) and renders the welcome chips in 73 ms.

### Progress summary
| round | bundle (raw) | JS (gzip) | FCP |
|-------|--------------|-----------|-----|
| start | 1.95 MB | 622 KB | 408 ms |
| lazy Settings/Skills/Cost | 1.91 MB | 621 KB | 384 ms |
| lazy Diff/Inline/Task/Preview | 1.69 MB | 539 KB | 364 ms |
| lazy syntax highlighter | 1.07 MB | 315 KB | 152 ms |
| lazy Mermaid | 1.07 MB | 314 KB | 152 ms |
| lazy Terminal/Browser | 0.74 MB | 223 KB | 128 ms |

We went from 622 KB → 223 KB (64% reduction) and 408 ms → 128 ms (69%
faster). Still above the 50 ms target but dramatically closer — the
remaining time is mostly the React render + Vite preview's HTTP overhead.
