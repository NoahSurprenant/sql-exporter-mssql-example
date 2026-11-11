"""python pages/record.py <grafana url> <snapshot key> <out dir>  (in the Playwright image)

Opens the snapshot in Chromium and records every Grafana API response (and the page HTML).
"""
import json, sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

base, key, out = sys.argv[1].rstrip("/"), sys.argv[2], sys.argv[3]
prefix = urlsplit(base).path  # /sql-exporter-mssql-example
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

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1600, "height": 2400})
    page.on("response", on_response)
    page.goto(f"{base}/dashboard/snapshot/{key}?orgId=1", wait_until="load")
    page.wait_for_timeout(15000)
    b.close()

json.dump(recorded, open(f"{out}/recording.json", "w"))
open(f"{out}/index.html", "w").write(html)
print(len(recorded), "API responses;", len(html), "bytes of HTML")
for k in sorted(recorded):
    print(recorded[k]["status"], k[:140])
