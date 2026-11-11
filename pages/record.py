"""python pages/record.py <grafana url> <minutes> <out dir>  (in the Playwright image)

1. Signed in, opens the dashboard on the last <minutes> as a fixed range and publishes a snapshot
   through Grafana's own share drawer, which stores every panel's data as the panel received it
   (the transformations are applied again when the snapshot is shown).
2. Signed out, as a visitor of the site, opens the snapshot and records the page's HTML and every
   API response Grafana gives it: what pages/sw.js replays.

Writes index.html, recording.json and the snapshot key (key.txt) to <out dir>.
"""
import json
import sys
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

base, minutes, out = sys.argv[1].rstrip("/"), int(sys.argv[2]), sys.argv[3]
prefix = urlsplit(base).path  # /sql-exporter-mssql-example
end = int(time.time() * 1000)
start = end - minutes * 60 * 1000
# Tall enough for every panel: Grafana only queries the panels on screen.
viewport = {"width": 1600, "height": 6000}

with sync_playwright() as p:
    browser = p.chromium.launch()

    # 1. Publish the snapshot. Anonymous visitors can't; admin:admin is the throwaway stack's default.
    # A header, not http_credentials: those are only sent after a 401, and anonymous access never
    # gives one.
    admin = browser.new_context(extra_http_headers={"Authorization": "Basic YWRtaW46YWRtaW4="}, viewport=viewport)
    page = admin.new_page()
    page.goto(f"{base}/d/sql-server-example?orgId=1&from={start}&to={end}&refresh=&shareView=snapshot", wait_until="load")
    page.wait_for_selector("text=Avg elapsed", timeout=90000)
    page.wait_for_timeout(20000)  # the log panels are the slowest
    with page.expect_response(lambda r: r.request.method == "POST" and r.url.endswith("/api/snapshots")) as created:
        page.get_by_role("button", name="Publish snapshot").click()
    response = created.value.json()
    if "key" not in response:
        sys.exit(f"publishing the snapshot failed: {response}")
    key = response["key"]
    admin.close()

    # 2. Record it as a visitor sees it.
    recorded, html = {}, None

    def on_response(resp):
        global html
        u = urlsplit(resp.url)
        if resp.request.resource_type == "document" and "/dashboard/snapshot/" in u.path:
            html = resp.text()
        if u.path.startswith((prefix + "/api/", prefix + "/apis/", prefix + "/avatar/")):
            try:
                body = resp.body().decode("utf-8", "replace")
            except Exception:
                body = ""
            recorded[f"{resp.request.method} {u.path[len(prefix):]}" + (f"?{u.query}" if u.query else "")] = {
                "status": resp.status, "type": resp.headers.get("content-type", "application/json"), "body": body}

    visitor = browser.new_context(viewport=viewport)
    page = visitor.new_page()
    page.on("response", on_response)
    page.goto(f"{base}/dashboard/snapshot/{key}?orgId=1", wait_until="load")
    page.wait_for_selector("text=Avg elapsed", timeout=90000)
    page.wait_for_timeout(10000)
    browser.close()

json.dump(recorded, open(f"{out}/recording.json", "w"))
open(f"{out}/index.html", "w").write(html)
open(f"{out}/key.txt", "w").write(key)
print(f"snapshot {key}: {len(recorded)} API responses, {len(html)} bytes of HTML")
for k in sorted(recorded):
    print(" ", recorded[k]["status"], k[:140])
