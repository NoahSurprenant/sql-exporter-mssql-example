"""python pages/check_site.py <site url>  (in the Playwright image, with Grafana stopped)

Opens the built site with nothing behind it but static files and checks the dashboard rendered
from the recording: panel titles, the example database, a stored procedure, a plan.
"""
import sys
from playwright.sync_api import sync_playwright

EXPECT = ["Top statements", "ExampleShop", "dbo.OrdersAtTotal", "IX_Orders_PlacedAt", "LCK_M_",
          "Plan warnings", "schemas.microsoft.com/sqlserver/2004/07/showplan"]

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 4400})
    page.goto(sys.argv[1], wait_until="load")
    # The first visit installs the service worker and reloads under it.
    page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=60000)
    page.wait_for_selector("text=Avg elapsed", timeout=60000)
    page.wait_for_timeout(8000)
    text = page.inner_text("body")
    page.screenshot(path=sys.argv[2] if len(sys.argv) > 2 else "pages-site.png", full_page=True)
    browser.close()

missing = [e for e in EXPECT if e not in text]
if missing:
    sys.exit(f"FAILED: the static site is missing {missing}")
print("OK: the static site renders the dashboard from the recording")
