#!/bin/bash
# The compose `setup` service: runs setup.sql and workload.sql against the mssql service, using the
# sqlcmd that ships in the SQL Server image.
set -euo pipefail

# mssql-tools18 in current images; 2017 and older 2019 images have only mssql-tools.
for candidate in /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd; do
  if [ -x "$candidate" ]; then sqlcmd=$candidate; break; fi
done
: "${sqlcmd:?no sqlcmd found in the image}"

# -C trusts the server's self-signed certificate; mssql-tools18 encrypts by default.
run() { "$sqlcmd" -S mssql -U sa -P "$MSSQL_SA_PASSWORD" -C "$@"; }

# `setup.sh contention` runs the blocking chain and deadlock (sql/contention) instead.
if [ "${1:-}" = contention ]; then
  export sqlcmd
  exec /sql/contention/run.sh mssql
fi

# `setup.sh workload` reruns only the workload, which the OpenTelemetry check needs: the receiver
# reports what changed between two of its collections.
if [ "${1:-}" != workload ]; then
  run -b -i /sql/setup.sql -v EXPORTER_PASSWORD="$EXPORTER_PASSWORD"
  # Not -b: a job already started by its schedule is fine.
  run -i /sql/agent.sql
fi
# Not -b: the workload ends with a deliberate error.
run -i /sql/workload.sql > /dev/null
echo "${1:-setup and workload} done"
