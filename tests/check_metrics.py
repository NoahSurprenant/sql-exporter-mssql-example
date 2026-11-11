"""Scrapes sql_exporter and checks that every query in the collector files returned data.

    python tests/check_metrics.py [--url http://localhost:9399/metrics] [--timeout 180]

Standard library only, so it runs unchanged on the Linux and Windows runners. Every metric_name in
collectors/*.collector.yml must have at least one sample: a query that fails (a permission it
lacks, a DMV column that differs between versions) leaves its metrics out of the scrape, and this
catches it. A few checks go further and look for the workload in sql/workload.sql.
"""

import argparse
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLE = re.compile(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)')


def collector_metrics():
    """{metric name: collector file} for every metric the collectors define."""
    metrics = {}
    for path in sorted((ROOT / "collectors").glob("*.collector.yml")):
        for match in re.finditer(r'^\s*-\s*metric_name:\s*(\S+)', path.read_text(), re.M):
            metrics[match.group(1)] = path.name
    return metrics


def scrape(url, timeout):
    """The scrape body, retrying until the exporter answers with 200 or the timeout passes."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                return response.read().decode()
        except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
            if time.monotonic() > deadline:
                sys.exit(f"no scrape from {url} within {timeout}s: {error}")
            time.sleep(3)


def parse(body):
    """[(name, labels, value)] for every sample line."""
    samples = []
    for line in body.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        match = SAMPLE.match(line)
        if match:
            samples.append((match.group(1), match.group(2) or "", float(match.group(3))))
    return samples


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:9399/metrics")
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()

    expected = collector_metrics()
    if not expected:
        sys.exit("no metric_name found under collectors/")

    samples = parse(scrape(args.url, args.timeout))
    counts = {}
    for name, _, _ in samples:
        counts[name] = counts.get(name, 0) + 1

    failures = []
    rows = []
    for name, source in expected.items():
        count = counts.get(name, 0)
        rows.append((source, name, count))
        if count == 0:
            failures.append(f"{name} ({source}) has no samples: its query failed or returned no rows")

    def values(name, label_pattern=""):
        return [v for n, labels, v in samples if n == name and re.search(label_pattern, labels)]

    # The exporter's own view of the target: 1 when it could connect and run the collectors.
    if values("up") != [1.0]:
        failures.append(f"up is {values('up')}, not [1]")

    # The workload's statements are in the plan cache, attributed to their database.
    shop = values("mssql_query_executions_total", r'database="ExampleShop"')
    if not shop:
        failures.append("mssql_query_executions_total has no statements for ExampleShop")
    elif max(shop) < 200:
        failures.append(f"no ExampleShop statement ran 200 times (max {max(shop)}); the workload loops 200")
    if not values("mssql_query_executions_total", r'query="[^"]*FROM dbo\.Orders AS o WHERE o\.CustomerId'):
        failures.append("the workload's orders-by-customer statement is missing from the query label")

    # The stored procedures, by name: the exporter's login resolves them with VIEW ANY DEFINITION
    # alone, without a user in ExampleShop. 50 calls each.
    for procedure in ("dbo.CustomerOrders", "dbo.OrdersAtTotal", "dbo.RegionRevenue"):
        calls = values("mssql_procedure_executions_total",
                       rf'database="ExampleShop".*procedure="{re.escape(procedure)}"')
        if not calls or max(calls) < 50:
            failures.append(f"mssql_procedure_executions_total for {procedure} is {calls}, expected >= 50")

    # OrdersAtTotal filters on Orders.Total, which has no index.
    if not values("mssql_missing_index_improvement",
                  r'database="ExampleShop".*equality_columns="\[Total\]".*table="[^"]*\[Orders\]"'):
        failures.append("no missing-index suggestion for ExampleShop's Orders.Total")

    # workload.sql ends with a divide by zero.
    if not any(v >= 1 for v in values("mssql_user_errors")):
        failures.append("mssql_user_errors is 0; the workload's divide by zero was not counted")

    report = ["| Collector | Metric | Samples |", "| --- | --- | ---: |"]
    report += [f"| {s} | `{n}` | {c} |" for s, n, c in rows]
    print("\n".join(report))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("\n".join(report) + "\n\n")

    if failures:
        print("\nFAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print(f"\nOK: all {len(expected)} metrics present, workload visible")


if __name__ == "__main__":
    main()
