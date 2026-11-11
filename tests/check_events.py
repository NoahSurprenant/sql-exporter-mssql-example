"""Checks the OpenTelemetry Collector's SQL Server events for the example workload.

    python tests/check_events.py --events <file> --workload "<command>" [--timeout 300]

Standard library only. The sql_server receiver reports deltas: a query or procedure appears only
once it ran between two collections. So this reruns the workload (--workload, a shell command) every
round, then reads the events file the collector's file exporter writes, until every check passes
or the timeout runs out.
"""

import argparse
import json
import os
import subprocess
import sys
import time

ROUND_SECONDS = 25


def value(any_value):
    """The Python value of an OTLP/JSON AnyValue."""
    for key in ("stringValue", "intValue", "doubleValue", "boolValue"):
        if key in any_value:
            return any_value[key]
    return None


def read_events(path):
    """[(event name, {attribute: value})] from the file exporter's OTLP/JSON lines."""
    events = []
    if not os.path.exists(path):
        return events
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                batch = json.loads(line)
            except json.JSONDecodeError:
                continue  # a line still being written
            for resource in batch.get("resourceLogs", []):
                for scope in resource.get("scopeLogs", []):
                    for record in scope.get("logRecords", []):
                        attributes = {a["key"]: value(a["value"]) for a in record.get("attributes", [])}
                        events.append((record.get("eventName", ""), attributes))
    return events


def check(events, procedures=True):
    """The checks still failing, as messages; empty when all pass."""
    def find(name, predicate):
        return [a for n, a in events if n == name and a.get("db.namespace") == "ExampleShop" and predicate(a)]

    failures = []
    if not find("db.server.top_query", lambda a: "dbo.Orders" in str(a.get("db.query.text", ""))):
        failures.append("db.server.top_query: no ExampleShop statement on dbo.Orders")
    if not find("db.server.query_plan", lambda a: "<ShowPlanXML" in str(a.get("sqlserver.query_plan", ""))):
        failures.append("db.server.query_plan: no ExampleShop execution plan (ShowPlanXML)")
    # Deadlocks have no database of their own: the graph names it. sql/contention makes one.
    if not [a for n, a in events if n == "db.server.deadlock"]:
        failures.append("db.server.deadlock: no deadlock graph (run sql/contention first)")
    if not procedures:
        return failures
    # The receiver names procedures [schema].[name].
    if not find("db.server.top_procedure", lambda a: a.get("sqlserver.procedure_name") == "[dbo].[OrdersAtTotal]"):
        names = sorted({str(a.get("sqlserver.procedure_name")) for n, a in events if n == "db.server.top_procedure"})
        failures.append(f"db.server.top_procedure: no [dbo].[OrdersAtTotal] (saw {names})")
    if not find("db.server.procedure_definition",
                lambda a: "OrdersAtTotal" in str(a.get("sqlserver.procedure.definition", ""))):
        failures.append("db.server.procedure_definition: no definition of dbo.OrdersAtTotal")
    return failures


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", required=True)
    parser.add_argument("--workload", required=True)
    parser.add_argument("--timeout", type=int, default=300)
    # SQL Server 2017 before CU3 has no sys.dm_exec_procedure_stats.total_spills, which the
    # receiver's procedure query reads: db.server.top_procedure (and so procedure_definition) can't
    # work there.
    parser.add_argument("--no-procedures", action="store_true")
    args = parser.parse_args()

    deadline = time.monotonic() + args.timeout
    while True:
        subprocess.run(args.workload, shell=True, check=True, stdout=subprocess.DEVNULL)
        time.sleep(ROUND_SECONDS)
        events = read_events(args.events)
        failures = check(events, procedures=not args.no_procedures)
        if not failures or time.monotonic() > deadline:
            break
        print(f"{len(events)} events so far, waiting on: {'; '.join(failures)}")

    counts = {}
    for name, _ in events:
        counts[name] = counts.get(name, 0) + 1
    report = ["| Event | Records |", "| --- | ---: |"] + [f"| `{n}` | {c} |" for n, c in sorted(counts.items())]
    print("\n".join(report))
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("\n".join(report) + "\n\n")

    if failures:
        print("\nFAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    plan = next(a for n, a in events if n == "db.server.query_plan" and a.get("db.namespace") == "ExampleShop")
    checked = "query and plan events (procedures skipped)" if args.no_procedures else "query, plan, procedure and definition events"
    print(f"\nOK: {checked}; the plan is {len(str(plan['sqlserver.query_plan']))} characters of XML")


if __name__ == "__main__":
    main()
