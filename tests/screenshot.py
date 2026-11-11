"""Screenshots the Grafana dashboard: python tests/screenshot.py <url> <out.png>

Run in the Playwright image (CI does), which has the browser. The viewport is as tall as the
dashboard, since Grafana only loads the panels it has on screen.
"""

import sys

from playwright.sync_api import sync_playwright

url, out = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 2200})
    # Not "networkidle": Grafana keeps a live connection open, so the network never goes quiet.
    page.goto(f"{url}/d/sql-server-example?orgId=1&kiosk&theme=dark", wait_until="load")
    page.wait_for_selector("[data-viz-panel-key], .react-grid-item", timeout=60000)
    page.wait_for_timeout(10000)
    page.screenshot(path=out, full_page=True)
    browser.close()
