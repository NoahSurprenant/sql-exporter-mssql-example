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
do. This example logs in as a dedicated `sql_exporter` login with `VIEW SERVER STATE`,
`VIEW ANY DEFINITION` and `CONNECT ANY DATABASE` (to name objects inside the databases, without
reading any table), plus a user in `msdb` with `SELECT` on `dbo.backupset`, `dbo.sysjobs` and
`dbo.sysjobhistory` for backup and SQL Server Agent history
(see [`sql/setup.sql`](sql/setup.sql)). `sql_exporter.yml` runs every collector file (`mssql_*`).

| Collector | Source | What it reports |
| --- | --- | --- |
| [`mssql_standard`](collectors/mssql_standard.collector.yml) | sql_exporter's upstream example, unchanged | Connections per database, deadlocks, user errors, page life expectancy, batch requests, buffer cache hit ratio, I/O stalls per database, memory, page faults |
| [`mssql_query_stats`](collectors/mssql_query_stats.collector.yml) | Written for this example | The plan cache's top 20 statements per database (executions, elapsed and CPU time, logical and physical reads, rows, slowest run), and the top 25 wait types |
| [`mssql_procedure_stats`](collectors/mssql_procedure_stats.collector.yml) | Written for this example | The top 20 stored procedures per database by elapsed time (executions, elapsed and CPU time, logical and physical reads, slowest run), named `schema.procedure` |
| [`mssql_missing_indexes`](collectors/mssql_missing_indexes.collector.yml) | Written for this example | The optimizer's top 10 missing-index suggestions per database (table, equality / inequality / included columns, estimated improvement, impact %, seeks and scans it would have served), and a count of all suggestions per database |
| [`mssql_index_usage`](collectors/mssql_index_usage.collector.yml) | Written for this example | Unused indexes: maintained by every write but read by no query since SQL Server started, top 20 per database, with their size |
| [`mssql_activity`](collectors/mssql_activity.collector.yml) | Written for this example | Right now: user requests by state, blocked requests, the longest blocked wait, head blockers, the longest-running request, SQL Server's CPU |
| [`mssql_storage`](collectors/mssql_storage.collector.yml) | Written for this example | Data and log size and log space used per database, tempdb by use, time since each database's last full / differential / log backup |
| [`mssql_io_files`](collectors/mssql_io_files.collector.yml) | Written for this example | Reads, writes and their stall per database and file type, for read and write latency |
| [`mssql_agent`](collectors/mssql_agent.collector.yml) | Written for this example | Whether SQL Server Agent is running; per job, whether it is enabled, its last outcome, how long ago and how long it last ran, and its failed runs |
| [`mssql_query_store`](collectors/mssql_query_store.collector.yml) | Written for this example | From Query Store, in every database that has it on: queries that ran with more than one plan, and each plan's executions and average duration, which shows plan regressions |

`mssql_standard`'s buffer cache hit ratio is the raw counter without its base, so it isn't a
ratio; the dashboard leaves it out.

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
| `db.server.deadlock` | Every deadlock graph, from SQL Server's always-on `system_health` session (a second receiver, `sql_query/deadlocks`) |
| `db.server.errorlog` | SQL Server's own error log (Linux compose stack only: read from the container's log directory, [`otelcol/loki.yaml`](otelcol/loki.yaml)) |

On the way to Loki ([`otelcol/loki.yaml`](otelcol/loki.yaml)) each plan also gets its estimated
cost, degree of parallelism and warnings pulled out of the XML: implicit conversions, key lookups,
scans, spills to tempdb, missing indexes, joins with no predicate.

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

## Browse it: GitHub Pages

**https://noahsurprenant.github.io/sql-exporter-mssql-example/** is the Grafana dashboard from the
latest CI run on `main` (SQL Server 2022), with no server behind it:

- CI collects for 15 minutes, then a browser publishes a snapshot of the dashboard through
  Grafana's own share drawer: every panel's data, as the panel received it, over that fixed window.
  It then opens the snapshot as a visitor and records the handful of API calls Grafana makes to
  show it ([`pages/record.py`](pages/record.py)).
- The site is Grafana's own web app (its `public/` files), the recording, and a service worker
  ([`pages/sw.js`](pages/sw.js)) that answers those calls from it. The first visit installs the
  worker and reloads.

Everything in the snapshot works as in Grafana: tooltips, zooming into the window, the tables,
expanding log lines to read a query or its plan. Anything that needs a live backend doesn't:
another time range, Explore, editing. It is a reproduction of Grafana for reading, not supported by
Grafana, and a Grafana upgrade may need [`pages/`](pages) adjusting; CI checks the built site with
Grafana stopped ([`pages/check_site.py`](pages/check_site.py)) before publishing it.

## Run it locally

Needs Docker with Compose.

Once it is up, open **http://localhost:3000**: Grafana, no login, with the **SQL Server example**
dashboard (Prometheus is on :9090, Loki on :3100). The events need the workload to run twice, a
collection apart: `docker compose run --rm setup workload`, or the `check_events.py` line below,
which does it. `docker compose run --rm setup contention` makes something to see in the blocking
panels: a 20-second blocking chain, a deadlock and a failed login
([`sql/contention`](sql/contention)).

| Row | Panels |
| --- | --- |
| Overview | Whether the exporter reaches SQL Server, SQL Server's CPU, blocked requests, deadlocks and user errors in the range, page life expectancy; batch requests, requests by state |
| Sessions | User sessions by program and by database (client connections only), and upstream's count of all sessions by database, which includes SQL Server's own background tasks (about 50, in master) |
| Blocking and deadlocks | Blocked requests, head blockers and the longest wait over time; the longest-running request; blocking chains (session, blocked by, wait, resource, statement); deadlock graphs |
| Statements and procedures | Top statements and procedures **in the time range**: executions, total and average elapsed, average CPU and reads per execution; top waits |
| Query plans | Plan warnings per query (cost, parallelism, implicit conversion, key lookup, scan, spill, missing index, join with no predicate); the plan XML; procedure definitions |
| Plan regressions | Queries with several plans and how much slower the slowest is than the fastest (force the fast one with `sp_query_store_force_plan`); each plan |
| Indexes | Missing-index suggestions; unused indexes |
| Storage, I/O and backups | Database and log sizes, read and write latency per file, tempdb, time since the last backup, log growths |
| SQL Server Agent jobs | Whether Agent is running, failing jobs, every job's last outcome, last run, duration and failed runs |
| Error log | Failed logins; SQL Server's error log (Linux compose stack) |

The dashboard JSON is generated: change [`stack/grafana/dashboard.mjs`](stack/grafana/dashboard.mjs)
and run `node stack/grafana/dashboard.mjs`.

```sh
docker compose up -d                        # SQL Server 2022; MSSQL_VERSION=2017, 2019 or 2025 for others
# With MSSQL_VERSION=2017 also set EXPORTER_GODEBUG=x509negativeserial=1 (see compose.yaml)
docker compose run --rm setup contention    # blocking, a deadlock and a failed login
python3 tests/check_metrics.py              # every collector query returned data
curl -s localhost:9399/metrics | grep '^mssql_query_executions_total'
# Reruns the workload until the collector has reported the query, plan and procedure events
sudo python3 tests/check_events.py --events out/events.jsonl --workload "docker compose run --rm -T setup workload"
python3 tests/check_grafana.py              # every dashboard panel returns data, through Grafana
docker compose down
```

The `setup` container creates the exporter login and an `ExampleShop` database with Query Store
on, two SQL Server Agent jobs ([`sql/agent.sql`](sql/agent.sql): one succeeds, one fails, both every
minute; the compose stack turns Agent on), then runs
[`sql/workload.sql`](sql/workload.sql), a few hundred parameterized queries, one deliberate
error, and a stored procedure compiled once for each of two very different parameter values, the
second plan much slower for the common value: a plan regression for Query Store to show. sql_exporter starts once that finishes.

## Run it on Windows

There is no supported SQL Server container for Windows, so on Windows this is a normal SQL Server
installation and the exporter's Windows binary from its
[releases](https://github.com/burningalchemist/sql_exporter/releases):

```powershell
sqlcmd -S localhost -U sa -P <sa password> -C -b -i sql/setup.sql -v EXPORTER_PASSWORD=<password>
Start-Service SQLSERVERAGENT                # Agent, for the example jobs
sqlcmd -S localhost -U sa -P <sa password> -C -i sql/agent.sql
sqlcmd -S localhost -U sa -P <sa password> -C -i sql/workload.sql
$env:MSSQL_SA_PASSWORD = "<sa password>"; ./sql/contention/run.ps1
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
