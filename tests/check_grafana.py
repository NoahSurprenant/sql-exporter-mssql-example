"""Checks Grafana end to end: every panel of the provisioned dashboard returns data.

    python tests/check_grafana.py [--url http://localhost:3000] [--timeout 180]

Standard library only. Runs each panel's query through Grafana's own query API (/api/ds/query), so
it covers the data sources, Prometheus scraping sql_exporter and Loki receiving the collector's
events, not just the dashboard file. Run after tests/check_events.py, so the events exist.
"""

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "stack" / "grafana" / "dashboards" / "sql-server.json"
# Blocking chains come from query samples, taken every 10 seconds: one can miss a 20-second chain.
MAY_BE_EMPTY = {"Blocking chains"}


def call(url, body=None):
    request = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def rows(result):
    """Data points across a /api/ds/query result's frames."""
    total = 0
    for frame in result.get("frames", []):
        values = frame.get("data", {}).get("values", [])
        if values:
            total += len(values[0])
    return total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:3000")
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()

    dashboard = json.loads(DASHBOARD.read_text())
    panels = [p for p in dashboard["panels"] if p.get("targets")]
    deadline = time.monotonic() + args.timeout
    while True:
        failures, report = [], ["| Panel | Data source | Rows |", "| --- | --- | ---: |"]
        try:
            for uid in ("prometheus", "loki"):
                health = call(f"{args.url}/api/datasources/uid/{uid}/health")
                if health.get("status") != "OK":
                    failures.append(f"data source {uid}: {health}")
            call(f"{args.url}/api/dashboards/uid/{dashboard['uid']}")
            for panel in panels:
                target = panel["targets"][0]
                query = dict(target, refId="A", maxDataPoints=100, intervalMs=15000)
                if panel["datasource"]["type"] == "loki":
                    query["queryType"] = "range"
                result = call(f"{args.url}/api/ds/query",
                              {"queries": [query], "from": "now-1h", "to": "now"})["results"]["A"]
                count = rows(result)
                report.append(f"| {panel['title']} | {panel['datasource']['uid']} | {count} |")
                if result.get("error"):
                    failures.append(f"{panel['title']}: {result['error']}")
                elif count == 0 and panel["title"] not in MAY_BE_EMPTY:
                    failures.append(f"{panel['title']}: no data")
        except OSError as error:
            failures.append(f"Grafana not answering: {error}")
        if not failures or time.monotonic() > deadline:
            break
        print("waiting on: " + "; ".join(failures))
        time.sleep(10)

    print("\n".join(report))
    if failures:
        print("\nFAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print(f"\nOK: both data sources healthy, {len(panels)} panels queried through Grafana")


if __name__ == "__main__":
    main()
