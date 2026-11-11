#!/bin/bash
# Runs the contention scripts beside each other: a 20-second blocking chain and a deadlock, plus a
# failed login. `sql/setup.sh contention` calls it in the compose setup container; run.ps1 is the
# same for Windows. Needs $sqlcmd and $MSSQL_SA_PASSWORD; $1 is the server.
set -u
dir=$(dirname "$0")
sa() { "$sqlcmd" -S "$1" -U sa -P "$MSSQL_SA_PASSWORD" -C -i "$2" > /dev/null 2>&1; }
sa "$1" "$dir/blocker.sql" &
sleep 2
sa "$1" "$dir/blocked.sql" &
sa "$1" "$dir/deadlock_a.sql" &
sleep 1
sa "$1" "$dir/deadlock_b.sql" &
# A wrong password: "Login failed for user" in SQL Server's error log.
"$sqlcmd" -S "$1" -U sql_exporter -P not-the-password -C -Q "SELECT 1" > /dev/null 2>&1
wait
echo "contention done"
