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

## Run it locally

Needs Docker with Compose.

```sh
docker compose up -d                        # SQL Server 2022; MSSQL_VERSION=2017, 2019 or 2025 for others
python3 tests/check_metrics.py              # every collector query returned data
curl -s localhost:9399/metrics | grep '^mssql_query_executions_total'
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
  - the Linux build inside WSL 2 (Ubuntu, a real Linux kernel in its own VM), connecting to the
    Windows host over WSL's virtual network and through the Windows firewall: a Linux exporter
    scraping a Windows database server, as in a typical Kubernetes deployment.

Both run [`tests/check_metrics.py`](tests/check_metrics.py), which fails if any `metric_name` in
the collector files has no samples (a query that errors, for a missing permission or a DMV that
differs between versions, drops out of the scrape), and checks that the workload shows up in the
query statistics. Each job's summary has a table of every metric and its sample count.

## Adding a query

Add a metric to a collector file, or a new `*.collector.yml` with its name in `sql_exporter.yml`'s
`collectors` list. The test picks up every `metric_name` automatically, so CI checks it on every
SQL Server version and on both operating systems.

## License

MIT. `collectors/mssql_standard.collector.yml` is from sql_exporter, also MIT.
