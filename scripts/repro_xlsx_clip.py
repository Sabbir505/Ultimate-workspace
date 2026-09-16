"""Reproduce the xlsx left-clipping with the EXACT converter CSS from
src-tauri/src/chat/office.rs (doc_shell + sheet_css), then compare candidate
fixes. Prints measurements per variant."""
from playwright.sync_api import sync_playwright

SHEET_CSS = """
.sheet{margin:0 auto 34px;max-width:100%;overflow-x:auto}
.sheet h2{font-size:13pt;font-weight:600;color:#334155;margin:0 0 10px}
table{border-collapse:collapse;margin:0 auto;background:#fff;font-size:11pt;box-shadow:0 1px 4px rgba(15,23,42,.12)}
th,td{border:1px solid #e2e8f0;padding:7px 12px;text-align:left;vertical-align:top}
th{background:#2563eb;color:#fff;font-weight:600}
tr:nth-child(even) td{background:#f8fafc}
"""

FIX_CSS = """
.sheet{margin:0 0 34px;max-width:100%;overflow-x:auto}
.sheet h2{font-size:13pt;font-weight:600;color:#334155;margin:0 0 10px}
table{border-collapse:collapse;margin:0;background:#fff;font-size:11pt;box-shadow:0 1px 4px rgba(15,23,42,.12)}
th,td{border:1px solid #e2e8f0;padding:7px 12px;text-align:left;vertical-align:top}
th{background:#2563eb;color:#fff;font-weight:600}
tr:nth-child(even) td{background:#f8fafc}
"""


def page(css: str) -> str:
    cols = "".join(
        f'<col style="width:{w}px"/>' for w in (190, 90, 90, 90, 170, 120)
    )
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{background:#f1f5f9}}
body{{font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;padding:28px}}
{css}
</style></head><body>
<div class="sheet"><h2>Pricing</h2>
<table><colgroup>{cols}</colgroup>
<tr><th>Model</th><th>In / 1M</th><th>Out / 1M</th><th>Cache / 1M</th><th>Deal / Note</th><th>Best on $10</th></tr>
<tr><td>MiniMax 2.0 (FREE)</td><td>$0.10</td><td>$0.20</td><td>$0.002</td><td>Free, 100/day</td><td>~13,000</td></tr>
<tr><td>Grok 3 Mini (99% off)</td><td>$0.435</td><td>$0.87</td><td>$0.0036</td><td>~$50 effective</td><td>~4,000</td></tr>
<tr><td>Sources</td><td colspan="5">commandcode.ai/pricing, commandcode.ai/docs/resources/pricing-limits, commandcode.ai/docs/plans/go, commandcode.ai/models. Checked 2026-09-14.</td></tr>
</table></div></body></html>"""


def measure(page, label: str) -> None:
    m = page.evaluate(
        """(() => {
          const sheet = document.querySelector('.sheet');
          const table = document.querySelector('table');
          const s = sheet.getBoundingClientRect();
          const t = table.getBoundingClientRect();
          // scrollLeft minimum: scroll fully left, read back
          sheet.scrollLeft = 999999;
          const maxL = sheet.scrollLeft;
          sheet.scrollLeft = 0;
          return {
            sheetW: Math.round(s.width),
            tableW: Math.round(t.width),
            tableLeftInset: Math.round(t.x - s.x),
            maxScrollLeft: Math.round(maxL),
            hiddenLeftPx: Math.round(Math.max(0, s.x - t.x)),
            scrollableWidth: Math.round(sheet.scrollWidth - sheet.clientWidth),
          };
        })()"""
    )
    print(label, m)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    pg = browser.new_page(viewport={"width": 560, "height": 800})
    for label, css in (("CURRENT ", SHEET_CSS), ("LEFT-ALIGN", FIX_CSS)):
        pg.set_content(page(css))
        pg.wait_for_timeout(200)
        measure(pg, label)
    browser.close()
