"""Capture the doc-preview scene: real ArtifactPreviewPane with a wide-table
docx (DocxViewer path) and an xlsx (converter-iframe path) at several widths."""
from playwright.sync_api import sync_playwright

OUT = r"D:/projects/Ultimate-workspace/Random Stuff"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1100, "height": 900})
    page.goto("http://localhost:1500/attachments-harness.html")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1200)

    page.get_by_role("button", name="Doc preview").click()
    page.wait_for_timeout(2500)  # docx generation + render

    for w in (560, 420):
        page.get_by_role("button", name=f"{w}px").click()
        page.wait_for_timeout(900)
        page.screenshot(path=f"{OUT}/attach-doc-docx-{w}.png")
        m = page.evaluate(
            """(() => {
              const wrap = document.querySelector('.docx-viewer-wrap');
              const wrapper = wrap?.querySelector('.docx-wrapper');
              const sec = wrap?.querySelector('section.docx');
              if (!wrapper) return null;
              const wr = wrapper.getBoundingClientRect();
              const sr = sec ? sec.getBoundingClientRect() : null;
              const parent = wrap.parentElement.getBoundingClientRect();
              return {
                wrapperLeftInParent: Math.round(wr.x - parent.x),
                wrapperW: Math.round(wr.width),
                sectionLeft: sr ? Math.round(sr.x - parent.x) : null,
                sectionW: sr ? Math.round(sr.width) : null,
                parentW: Math.round(parent.width),
                transform: wrapper.style.transform,
              };
            })()"""
        )
        print(w, m)

    page.get_by_role("button", name="xlsx", exact=True).click()
    page.wait_for_timeout(800)
    page.get_by_role("button", name="560px").click()
    page.wait_for_timeout(600)
    page.screenshot(path=f"{OUT}/attach-doc-xlsx-560.png")
    m = page.evaluate(
        """(() => {
          const iframe = document.querySelector('iframe.artifact-preview-html');
          if (!iframe) return null;
          const doc = iframe.contentDocument;
          const sheet = doc?.querySelector('.sheet');
          const table = doc?.querySelector('table');
          if (!sheet || !table) return { err: 'no sheet/table' };
          sheet.scrollLeft = 999999;
          const maxL = sheet.scrollLeft;
          sheet.scrollLeft = 0;
          const s = sheet.getBoundingClientRect();
          const t = table.getBoundingClientRect();
          return {
            sheetW: Math.round(s.width),
            tableW: Math.round(t.width),
            hiddenLeftPx: Math.round(Math.max(0, s.x - t.x)),
            maxScrollLeft: Math.round(maxL),
          };
        })()"""
    )
    print("xlsx", m)
    browser.close()
print("done")
