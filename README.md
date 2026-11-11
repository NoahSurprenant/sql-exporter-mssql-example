# sql_exporter + SQL Server example

A working example of [sql_exporter](https://github.com/burningalchemist/sql_exporter) exposing
Prometheus metrics from Microsoft SQL Server, tested in CI against SQL Server 2017, 2019, 2022 and 2025,
both as Linux containers and as native Windows installations.

## How it works

sql_exporter is a generic exporter: it knows nothing about SQL Server by itself. It connects to the
database as an ordinary client, and on every scrape of `/metrics` it runs the queries in its
*collector files* and turns each result row into Prometheus samples (some columns become labels,
others values). Nothing is stored in between scrapes.

```
SQL Server :1433  <──  sql_exporter :9399/metrics  <──  Prometheus / OpenTelemetry Collector
                       └ collectors/*.collector.yml
```

It does not need to run on the database server: anything that can reach port 1433 and log in will
do. This example logs in as a dedicated `sql_exporter` login with only `VIEW SERVER STATE` and
`VIEW ANY DEFINITION`, and no user in any database (see [`sql/setup.sql`](sql/setup.sql)).

| Collector | Source | What it reports |
| --- | --- | --- |
| [`mssql_standard`](collectors/mssql_standard.collector.yml) | sql_exporter's upstream example, unchanged | Connections per database, deadlocks, user errors, page life expectancy, batch requests, buffer cache hit ratio, I/O stalls per database, memory, page faults |
| [`mssql_query_stats`](collectors/mssql_query_stats.collector.yml) | Written for this example | The plan cache's top 20 statements per database (executions, elapsed and CPU time, logical and physical reads, rows, slowest run), and the top 25 wait types |
| [`mssql_procedure_stats`](collectors/mssql_procedure_stats.collector.yml) | Written for this example | The top 20 stored procedures per database by elapsed time (executions, elapsed and CPU time, logical and physical reads, slowest run), named `schema.procedure` |
| [`mssql_missing_indexes`](collectors/mssql_missing_indexes.collector.yml) | Written for this example | The optimizer's top 10 missing-index suggestions per database (table, equality / inequality / included columns, estimated improvement, impact %, seeks and scans it would have served), and a count of all suggestions per database |

## Query plans and procedure detail: the OpenTelemetry Collector

Metrics can't carry a query's full text or its execution plan. For those, the stack also runs the
[OpenTelemetry Collector](https://github.com/open-telemetry/opentelemetry-collector-contrib)'s
[`sql_server` receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/receiver/sqlserverreceiver)
([`otelcol/config.yaml`](otelcol/config.yaml)), which turns them into log events:

| Event | What it carries |
| --- | --- |
| `db.server.top_query` | The most expensive statements since the last collection: text (literals obfuscated), executions, CPU, elapsed time, reads, rows, `query_hash` |
| `db.server.query_plan` | The cached execution plan of each of those statements (ShowPlan XML), keyed by `query_hash` + `query_plan_hash` |
| `db.server.top_procedure` | The most expensive stored procedures since the last collection |
| `db.server.procedure_definition` | The source of each of those procedures |
| `db.server.query_sample` | What is executing at the moment of collection, with blocking |

The procedure events need SQL Server 2017 CU3 or later (`sys.dm_exec_procedure_stats.total_spills`):
on 2017 RTM the receiver logs `Invalid column name 'total_spills'` and reports none, which is why the
Windows 2017 jobs, installed without updates, skip those checks. `mssql_procedure_stats` works on
every version.

Like sql_exporter it pulls, logging in as its own `otel_collector` login. It reports deltas, so a
statement shows up from its second collection on, if it ran again in between. Here the events go
to `out/events.jsonl`; in production the logs pipeline would export to Loki or another log store,
where a `query_hash` seen on a slow-query dashboard leads to its full text and plan. The receiver's
logs signal is at
[development stability](https://github.com/open-telemetry/opentelemetry-collector/blob/main/docs/component-stability.md#development).

## Run it locally

Needs Docker with Compose.

Once it is up, open **http://localhost:3000**: Grafana, no login, with the **SQL Server example** dashboard.
Its top half is sql_exporter's metrics from Prometheus (throughput, connections, top statements,
top procedures, missing-index suggestions, waits); its bottom half the collector's events from Loki
(top queries, execution plans, procedures and their definitions, running queries). The events need
the workload to run twice, a collection apart: `docker compose run --rm setup workload`, or the
`check_events.py` line below, which does it. Prometheus is on :9090 and Loki on :3100.

```sh
docker compose up -d                        # SQL Server 2022; MSSQL_VERSION=2017, 2019 or 2025 for others
# With MSSQL_VERSION=2017 also set EXPORTER_GODEBUG=x509negativeserial=1 (see compose.yaml)
python3 tests/check_metrics.py              # every collector query returned data
curl -s localhost:9399/metrics | grep '^mssql_query_executions_total'
# Reruns the workload until the collector has reported the query, plan and procedure events
sudo python3 tests/check_events.py --events out/events.jsonl --workload "docker compose run --rm -T setup workload"
python3 tests/check_grafana.py              # every dashboard panel returns data, through Grafana
docker compose down
```

The `setup` container creates the exporter login and an `ExampleShop` database, then runs
[`sql/workload.sql`](sql/workload.sql), a few hundred parameterized queries and one deliberate
error, so the query statistics have something to show. sql_exporter starts once that finishes.

## Run it on Windows

There is no supported SQL Server container for Windows, so on Windows this is a normal SQL Server
installation and the exporter's Windows binary from its
[releases](https://github.com/burningalchemist/sql_exporter/releases):

```powershell
sqlcmd -S localhost -U sa -P <sa password> -C -b -i sql/setup.sql -v EXPORTER_PASSWORD=<password>
sqlcmd -S localhost -U sa -P <sa password> -C -i sql/workload.sql
.\sql_exporter.exe --config.file=sql_exporter.yml `
  --config.data-source-name="sqlserver://sql_exporter:<password>@localhost:1433?encrypt=true&trustservercertificate=true"
python tests/check_metrics.py
```

sql_exporter can also run as a Windows service; see its
[documentation](https://burningalchemist.github.io/sql_exporter/).

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push, pull request, and weekly:

- **Linux**: the Compose stack above, once per SQL Server image (`2017-latest`, `2019-latest`, `2022-latest`,
  `2025-latest`).
- **Windows**: SQL Server Developer edition installed on a `windows-2022` runner with
  [mssqlsuite](https://github.com/potatoqualitee/mssqlsuite), once per version, scraped two ways:
  - the checksum-verified Windows build of sql_exporter on the same machine, over localhost;
  - the same sql_exporter container as `compose.yaml`, on Docker Engine inside WSL 2 (Ubuntu, a
    Linux VM with its own kernel and address), connecting to the Windows host over WSL's virtual
    network and through the Windows firewall: a Linux Docker host scraping a Windows database
    server, as in a typical Kubernetes deployment.

Every job runs [`tests/check_metrics.py`](tests/check_metrics.py), which fails if any `metric_name`
in the collector files has no samples (a query that errors, for a missing permission or a DMV that
differs between versions, drops out of the scrape), and checks that the workload shows up in the
query statistics. Then [`tests/check_events.py`](tests/check_events.py) runs the OpenTelemetry
Collector beside it (the container on Linux and in WSL 2, the Windows build natively) and checks for
an ExampleShop top query, its plan, `dbo.OrdersAtTotal` in the top procedures, and its definition.
The Linux jobs also run [`tests/check_grafana.py`](tests/check_grafana.py), which queries every
dashboard panel through Grafana, and upload a screenshot of the dashboard as an artifact. Each
job's summary has a table of every metric and every event type.

## Adding a query

Add a metric to a collector file, or a new `*.collector.yml` with its name in `sql_exporter.yml`'s
`collectors` list. The test picks up every `metric_name` automatically, so CI checks it on every
SQL Server version and on both operating systems.

## License

MIT. `collectors/mssql_standard.collector.yml` is a byte-for-byte copy of sql_exporter's
`examples/mssql` at the pinned version (also MIT); CI fails if it drifts from upstream.
