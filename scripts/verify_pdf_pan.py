"""Verify the PDF-view left-edge fix: zoom the wide landscape PDF to 150% in
the doc-preview scene and measure whether the page's left edge stays
reachable (scrollLeft 0 must show the page's left edge, overflow to the right)."""
from playwright.sync_api import sync_playwright

OUT = r"D:/projects/Ultimate-workspace/Random Stuff"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1100, "height": 900})
    page.goto("http://localhost:1500/attachments-harness.html")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1200)

    page.get_by_role("button", name="Doc preview").click()
    page.wait_for_timeout(800)
    page.get_by_role("button", name="pdf", exact=True).click()
    page.wait_for_timeout(2500)  # pdf.js open + render

    # zoom in until the label reads 150%
    for _ in range(8):
        label = page.locator(".pdf-zoom-label").inner_text()
        if label.strip() == "150%":
            break
        page.locator(".pdf-toolbar-btn[title='Zoom in']").click()
        page.wait_for_timeout(150)
    print("zoom label:", page.locator(".pdf-zoom-label").inner_text())
    page.wait_for_timeout(800)

    m = page.evaluate(
        """(() => {
          const scroll = document.querySelector('.pdf-scroll');
          const pg = document.querySelector('.pdf-page');
          scroll.scrollLeft = 999999;
          const maxL = Math.round(scroll.scrollLeft);
          scroll.scrollLeft = 0;
          const s = scroll.getBoundingClientRect();
          const g = pg.getBoundingClientRect();
          return {
            scrollW: Math.round(s.width),
            pageW: Math.round(g.width),
            pageLeftInsetAtZero: Math.round(g.x - s.x),
            maxScrollLeft: maxL,
            overflowBothSides: g.x - s.x < 0 && g.right > s.right,
          };
        })()"""
    )
    print("pdf @150%:", m)
    page.screenshot(path=f"{OUT}/attach-doc-pdf-150.png")

    # scroll fully right: left edge must still be re-reachable (scrollLeft back to 0)
    page.evaluate("document.querySelector('.pdf-scroll').scrollLeft = 999999")
    page.wait_for_timeout(200)
    page.screenshot(path=f"{OUT}/attach-doc-pdf-150-right.png")
    back = page.evaluate(
        """(() => {
          const scroll = document.querySelector('.pdf-scroll');
          scroll.scrollLeft = 0;
          const pg = document.querySelector('.pdf-page');
          const s = scroll.getBoundingClientRect();
          const g = pg.getBoundingClientRect();
          return { leftInsetAfterReturn: Math.round(g.x - s.x) };
        })()"""
    )
    print("after returning to scrollLeft 0:", back)
    browser.close()
print("done")
