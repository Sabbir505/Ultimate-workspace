"""Capture the attachments harness in both scenes and both themes.

The harness page is served by the already-running vite dev server on
localhost:1500. Screenshots land in Random Stuff/ next to the other
review artifacts.
"""
import sys
from playwright.sync_api import sync_playwright

OUT = r"D:/projects/Ultimate-workspace/Random Stuff"


def shoot(page, name: str) -> None:
    page.screenshot(path=f"{OUT}/{name}.png")


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1100, "height": 900})
        page.goto("http://localhost:1500/attachments-harness.html")
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)

        # --- dark theme ---
        shoot(page, "attach-msgs-dark-top")
        page.mouse.wheel(0, 700)
        page.wait_for_timeout(300)
        shoot(page, "attach-msgs-dark-mid")
        page.mouse.wheel(0, 700)
        page.wait_for_timeout(300)
        shoot(page, "attach-msgs-dark-low")
        page.mouse.wheel(0, 900)
        page.wait_for_timeout(300)
        shoot(page, "attach-msgs-dark-bottom")

        # gallery scene
        page.get_by_role("button", name="Artifact gallery").click()
        page.wait_for_timeout(1200)
        shoot(page, "attach-gallery-dark")

        # --- light theme (the pill shows the CURRENT theme) ---
        page.get_by_role("button", name="Dark", exact=True).click()
        page.wait_for_timeout(600)
        shoot(page, "attach-gallery-light")
        page.get_by_role("button", name="User messages").click()
        page.wait_for_timeout(600)
        shoot(page, "attach-msgs-light-top")
        page.mouse.wheel(0, 700)
        page.wait_for_timeout(300)
        shoot(page, "attach-msgs-light-mid")

        browser.close()
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
