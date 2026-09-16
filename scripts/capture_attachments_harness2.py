"""Follow-up captures: gallery scrolled to the last row (both themes)."""
from playwright.sync_api import sync_playwright

OUT = r"D:/projects/Ultimate-workspace/Random Stuff"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1100, "height": 900})
    page.goto("http://localhost:1500/attachments-harness.html")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1200)

    page.get_by_role("button", name="Artifact gallery").click()
    page.wait_for_timeout(1000)
    box = page.locator(".artifact-lib-modal").bounding_box()
    print("modal box:", box)
    # scroll the internal virtualized list to the bottom
    page.locator(".artifact-lib-modal").evaluate(
        "el => { el.scrollTop = el.scrollHeight }"
    )
    page.wait_for_timeout(600)
    page.screenshot(path=f"{OUT}/attach-gallery-dark-scrolled.png")

    page.get_by_role("button", name="Dark", exact=True).click()
    page.wait_for_timeout(600)
    page.screenshot(path=f"{OUT}/attach-gallery-light-scrolled.png")

    # hover a card to reveal the delete button + hover elevation
    page.locator(".doc-card").first.hover()
    page.wait_for_timeout(400)
    page.screenshot(path=f"{OUT}/attach-gallery-light-hover.png")

    browser.close()
print("done")
