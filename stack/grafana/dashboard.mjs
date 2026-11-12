// Generates dashboards/sql-server.json: node stack/grafana/dashboard.mjs
// The dashboard is built here rather than hand-edited JSON, so its panels share one shape. After a
// change in Grafana's editor, port it back here (or export the JSON and drop this script).
import { writeFileSync } from "node:fs";

const P = { type: "prometheus", uid: "prometheus" };
const L = { type: "loki", uid: "loki" };
const SQL = '{service_name="sqlserver"}';
const event = (name) => `${SQL} | event_name="${name}"`;
// The receiver's own monitoring queries run in master; leave the system databases out.
const userDbs = '| db_namespace!~"master|msdb|model|tempdb"';
// A raw series without its metric name (any aggregation drops it), so instant queries on different
// metrics merge into one row.
const nameless = (m) => `max without(instance, job) (${m})`;

const panels = [];
let id = 0;
let y = 0;
let x = 0;
let rowHeight = 0;

// Lays panels out left to right, wrapping at 24 columns.
function place(w, h) {
  if (x + w > 24) { x = 0; y += rowHeight; rowHeight = 0; }
  const pos = { h, w, x, y };
  x += w;
  rowHeight = Math.max(rowHeight, h);
  return pos;
}
function row(title) {
  if (x > 0) { y += rowHeight; x = 0; rowHeight = 0; }
  panels.push({ type: "row", title, id: ++id, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] });
  y += 1;
}
const prom = (expr, extra = {}) => ({ datasource: P, expr, ...extra });
const loki = (expr, extra = {}) => ({ datasource: L, expr, queryType: "range", ...extra });
function add(type, title, description, w, h, targets, rest = {}) {
  const ds = targets[0].datasource;
  panels.push({
    type, title, description, id: ++id, datasource: ds, gridPos: place(w, h),
    targets: targets.map((t, i) => ({ refId: String.fromCharCode(65 + i), ...t })),
    fieldConfig: { defaults: {}, overrides: [] }, options: {}, ...rest,
  });
  return panels[panels.length - 1];
}

// expr: PromQL, or a ready target (a Loki one).
function stat(title, description, expr, w, { unit, thresholds, mappings, decimals, noValue } = {}) {
  const target = typeof expr === "string" ? prom(expr, { instant: true }) : expr;
  return add("stat", title, description, w, 4, [target], {
    fieldConfig: {
      defaults: {
        unit, decimals, noValue, mappings: mappings ?? [],
        color: { mode: "thresholds" },
        thresholds: { mode: "absolute", steps: thresholds ?? [{ color: "green", value: null }] },
      },
      overrides: [],
    },
    options: { reduceOptions: { calcs: ["lastNotNull"] }, colorMode: "value", graphMode: "none", textMode: "value" },
  });
}
function series(title, description, targets, w, h, { unit, stack, min } = {}) {
  return add("timeseries", title, description, w, h, targets, {
    fieldConfig: {
      defaults: { unit, min, custom: { fillOpacity: stack ? 30 : 10, stacking: { mode: stack ? "normal" : "none" }, showPoints: "never" } },
      overrides: [],
    },
    options: { legend: { displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi" } },
  });
}
// A table from instant Prometheus queries, joined on their labels.
function table(title, description, targets, w, h, { columns, hide = [], units = {}, calc = [], sortBy, mappings = {}, widths = {}, decimals = {} }) {
  const excludeByName = Object.fromEntries(["Time", "__name__", "instance", "job", "target", ...hide].map((k) => [k, true]));
  const overrides = Object.entries(units).map(([name, unit]) => ({
    matcher: { id: "byName", options: name }, properties: [{ id: "unit", value: unit }],
  }));
  for (const [name, m] of Object.entries(mappings)) {
    overrides.push({ matcher: { id: "byName", options: name }, properties: [{ id: "mappings", value: m }] });
  }
  for (const [name, width] of Object.entries(widths)) {
    overrides.push({ matcher: { id: "byName", options: name }, properties: [{ id: "custom.width", value: width }] });
  }
  for (const [name, d] of Object.entries(decimals)) {
    overrides.push({ matcher: { id: "byName", options: name }, properties: [{ id: "decimals", value: d }] });
  }
  return add("table", title, description, w, h, targets.map((t) => ({ ...t, instant: true, format: "table" })), {
    transformations: [
      { id: "merge", options: {} },
      ...calc.map(([alias, left, op, right]) => ({
        id: "calculateField",
        options: { mode: "binary", alias, binary: { left, operator: op, right }, replaceFields: false },
      })),
      // indexByName goes by the fields' original names, as renameByName does.
      { id: "organize", options: { excludeByName, renameByName: columns, indexByName: Object.fromEntries(Object.keys(columns).map((c, i) => [c, i])) } },
    ],
    fieldConfig: { defaults: { custom: { cellOptions: { type: "auto" } } }, overrides },
    options: { showHeader: true, sortBy: sortBy ? [{ displayName: sortBy, desc: true }] : [], cellHeight: "sm" },
  });
}
function logs(title, description, expr, w, h, maxLines = 200) {
  return add("logs", title, description, w, h, [loki(expr, { maxLines })], {
    options: { showTime: true, wrapLogMessage: true, enableLogDetails: true, sortOrder: "Descending", prettifyLogMessage: false },
  });
}
// A table from log events: their structured metadata as columns, one row per key (the latest).
// The query's lines are replaced with a short text (line_format): the table only reads the
// structured metadata, and a plan's XML line can be tens of KB.
function logTable(title, description, expr, w, h, { key, columns, units = {}, mappings = {}, maxLines = 1000 }) {
  expr = `${expr} | line_format "{{.event_name}}"`;
  const overrides = Object.entries(units).map(([name, unit]) => ({
    matcher: { id: "byName", options: name }, properties: [{ id: "unit", value: unit }],
  }));
  for (const [name, m] of Object.entries(mappings)) {
    overrides.push({ matcher: { id: "byName", options: name }, properties: [{ id: "mappings", value: m }] });
  }
  const fields = Object.keys(columns);
  return add("table", title, description, w, h, [loki(expr, { maxLines })], {
    transformations: [
      { id: "extractFields", options: { source: "labels", replace: false, keepTime: true } },
      { id: "groupBy", options: { fields: Object.fromEntries([[key, { operation: "groupby", aggregations: [] }],
        ...fields.filter((f) => f !== key).map((f) => [f, { operation: "aggregate", aggregations: ["lastNotNull"] }])]) } },
      { id: "organize", options: {
        renameByName: Object.fromEntries(fields.map((f) => [f === key ? f : `${f} (lastNotNull)`, columns[f]])),
        indexByName: Object.fromEntries(fields.map((f, i) => [f === key ? f : `${f} (lastNotNull)`, i])),
      } },
    ],
    fieldConfig: { defaults: { custom: { cellOptions: { type: "auto" } } }, overrides },
    options: { showHeader: true, cellHeight: "sm" },
  });
}
const flag = [{ type: "value", options: { true: { text: "⚠ yes", color: "orange" }, false: { text: "" } } }];
const red = (at) => [{ color: "green", value: null }, { color: "red", value: at }];

// ---------------------------------------------------------------------------------------------
row("Overview");
stat("Exporter reaches SQL Server", "sql_exporter's own up: 1 when it could log in and run its collectors.",
  'up{job="sql_exporter", target="mssql"}', 4,
  { thresholds: [{ color: "red", value: null }, { color: "green", value: 1 }],
    mappings: [{ type: "value", options: { 0: { text: "down" }, 1: { text: "up" } } }] });
stat("SQL Server CPU", "CPU used by SQL Server over the last minute (mssql_cpu_percent).", "mssql_cpu_percent", 4,
  { unit: "percent", thresholds: [{ color: "green", value: null }, { color: "orange", value: 70 }, { color: "red", value: 90 }] });
stat("Blocked requests", "Requests waiting on another session's lock right now.", "mssql_blocked_requests", 4,
  { thresholds: red(1) });
stat("Deadlocks", "Deadlocks in the dashboard's time range.", "sum(increase(mssql_deadlocks[$__range]))", 4,
  { decimals: 0, thresholds: red(1) });
stat("User errors", "Errors returned to clients in the time range: failed statements, constraint violations, deadlock victims.",
  "sum(increase(mssql_user_errors[$__range]))", 4, { decimals: 0, thresholds: [{ color: "green", value: null }, { color: "orange", value: 1 }] });
stat("Page life expectancy", "Seconds a data page stays in memory. Falling fast, or low for the server's memory, means memory pressure.",
  "mssql_page_life_expectancy_seconds", 4, { unit: "s", thresholds: [{ color: "red", value: null }, { color: "orange", value: 60 }, { color: "green", value: 300 }] });

series("Batch requests / s", "Batches received per second: overall throughput.", [prom("rate(mssql_batch_requests[1m])", { legendFormat: "batches" })], 12, 7, { unit: "reqps", min: 0 });
series("Requests by state", "Executing user requests: running on a CPU, runnable (waiting for one), suspended (waiting on a lock, I/O or memory).",
  [prom("mssql_requests", { legendFormat: "{{status}}" })], 12, 7, { stack: true, min: 0 });
// ---------------------------------------------------------------------------------------------
row("Sessions");
series("User sessions by program", "User sessions by the program name the client reported (mssql_user_sessions_by_program): an application holding more connections than it should stands out here. sql_exporter and the OpenTelemetry Collector both report go-mssqldb.",
  [prom("mssql_user_sessions_by_program", { legendFormat: "{{program}}" })], 8, 7, { min: 0 });

series("User sessions by database", "Client sessions by the database they are in (mssql_user_sessions). Short-lived connections, such as this example's workload, only show when a scrape catches them.",
  [prom("mssql_user_sessions", { legendFormat: "{{database}}" })], 8, 7, { min: 0 });
series("All sessions by database (incl. system tasks)", "Upstream mssql_standard's mssql_connections: every row of sys.sysprocesses, so SQL Server's own background tasks too (about 50, all in master). Kept as upstream reports it; User sessions by database is the client view.",
  [prom('mssql_connections{db!=""}', { legendFormat: "{{db}}" })], 8, 7, { min: 0 });

// ---------------------------------------------------------------------------------------------
row("Blocking and deadlocks");
series("Blocking", "Requests blocked right now, and how long the longest of them has waited.",
  [prom("mssql_blocked_requests", { legendFormat: "blocked requests" }),
   prom("mssql_head_blockers", { legendFormat: "head blockers" }),
   prom("mssql_blocked_wait_seconds_max", { legendFormat: "longest wait (s)" })], 12, 7, { min: 0 });
series("Longest running request", "Elapsed time of the longest user request executing at each scrape.",
  [prom("mssql_longest_request_seconds", { legendFormat: "longest request" })], 12, 7, { unit: "s", min: 0 });
logTable("Blocking chains", "From the collector's query samples (db.server.query_sample): every request seen blocked, the session blocking it, what it waited on, and its statement.",
  `${event("db.server.query_sample")} ${userDbs} | sqlserver_blocking_session_id!="" | sqlserver_blocking_session_id!="0"`, 24, 7,
  { key: "sqlserver_session_id", columns: { sqlserver_session_id: "Session", sqlserver_blocking_session_id: "Blocked by", db_namespace: "Database",
    sqlserver_wait_type: "Wait type", sqlserver_wait_time: "Wait (ms)", sqlserver_wait_resource: "Resource", db_query_text: "Statement" } });
logs("Deadlock graphs", "Every deadlock, from SQL Server's system_health session (db.server.deadlock). Expand one: the processes, the statements they ran, the resources they held and wanted, and which was chosen as the victim.",
  event("db.server.deadlock"), 24, 8, 50);

// ---------------------------------------------------------------------------------------------
row("Statements and procedures in the time range");
const range = (m) => `increase(${m}[$__range])`;
const topStatements = `topk(20, ${range("mssql_query_elapsed_seconds_total")} > 0)`;
const onStatements = (m) => `${range(m)} and on(database, query_hash) ${topStatements}`;
// Per execution, in PromQL: a statement first seen inside the range has no executions yet, and
// dividing in the table would show infinity; here those rows just have no average.
const perExec = (m, execs, on) => `(${range(m)} / (${range(execs)} > 0)) and on(${on}) `;
table("Top statements", "mssql_query_stats over the time range: the 20 statements with the most elapsed time. Avg is per execution. Statements whose plan left the cache drop out.",
  [prom(topStatements), prom(onStatements("mssql_query_executions_total")),
   ...["mssql_query_elapsed_seconds_total", "mssql_query_cpu_seconds_total", "mssql_query_logical_reads_total"].map((m) =>
     prom(perExec(m, "mssql_query_executions_total", "database, query_hash") + topStatements))],
  24, 9, {
    columns: { database: "Database", query: "Statement", "Value #B": "Executions", "Value #A": "Elapsed", "Value #C": "Avg elapsed", "Value #D": "Avg CPU", "Value #E": "Avg reads", query_hash: "Query hash" },
    units: { Elapsed: "s", "Avg elapsed": "s", "Avg CPU": "s", Executions: "short", "Avg reads": "short" }, sortBy: "Elapsed",
    widths: { Database: 120, Statement: 520 }, decimals: { Executions: 0, "Avg reads": 0 },
  });
const topProcs = `topk(20, ${range("mssql_procedure_elapsed_seconds_total")} > 0)`;
const onProcs = (m) => `${range(m)} and on(database, procedure) ${topProcs}`;
table("Top stored procedures", "mssql_procedure_stats over the time range: the 20 procedures with the most elapsed time.",
  [prom(topProcs), prom(onProcs("mssql_procedure_executions_total")),
   ...["mssql_procedure_elapsed_seconds_total", "mssql_procedure_cpu_seconds_total", "mssql_procedure_logical_reads_total"].map((m) =>
     prom(perExec(m, "mssql_procedure_executions_total", "database, procedure") + topProcs))],
  24, 7, {
    columns: { database: "Database", procedure: "Procedure", "Value #B": "Executions", "Value #A": "Elapsed", "Value #C": "Avg elapsed", "Value #D": "Avg CPU", "Value #E": "Avg reads" },
    units: { Elapsed: "s", "Avg elapsed": "s", "Avg CPU": "s", Executions: "short", "Avg reads": "short" }, sortBy: "Elapsed",
    decimals: { Executions: 0, "Avg reads": 0 },
  });
add("bargauge", "Top waits", "What requests waited on most in the time range (mssql_wait_stats, idle waits left out). LCK_*: blocking; PAGEIOLATCH_*: reading pages from disk; WRITELOG: log writes; SOS_SCHEDULER_YIELD / CXPACKET: CPU and parallelism.",
  24, 7, [prom(`topk(8, ${range("mssql_wait_seconds_total")} > 0)`, { instant: true, legendFormat: "{{wait_type}}" })], {
    fieldConfig: { defaults: { unit: "s", min: 0, color: { mode: "continuous-BlYlRd" } }, overrides: [] },
    options: { orientation: "horizontal", displayMode: "basic", showUnfilled: true, reduceOptions: { calcs: ["lastNotNull"] } },
  });

// ---------------------------------------------------------------------------------------------
row("Plan regressions (Query Store)");
const byQuery = "database, query_id, query";
table("Queries with more than one plan", "mssql_query_store: queries Query Store has seen run with several plans, and how much slower their slowest plan is than their fastest. A big ratio is a plan regression: force the fast plan with EXEC sp_query_store_force_plan @query_id, @plan_id (the plan ids are in the next table).",
  [prom(`max by (${byQuery}) (mssql_query_store_plan_avg_duration_seconds) / min by (${byQuery}) (mssql_query_store_plan_avg_duration_seconds)`),
   prom(`count by (${byQuery}) (mssql_query_store_plan_avg_duration_seconds)`),
   prom(`min by (${byQuery}) (mssql_query_store_plan_avg_duration_seconds)`),
   prom(`max by (${byQuery}) (mssql_query_store_plan_avg_duration_seconds)`)], 24, 6, {
    columns: { database: "Database", query_id: "Query id", query: "Query", "Value #B": "Plans", "Value #C": "Fastest plan avg", "Value #D": "Slowest plan avg", "Value #A": "Slowest / fastest" },
    units: { "Fastest plan avg": "s", "Slowest plan avg": "s", "Slowest / fastest": "x" }, decimals: { Plans: 0, "Slowest / fastest": 1 },
    widths: { Query: 420 }, sortBy: "Slowest / fastest",
  });
table("Their plans", "Each plan of those queries: how often it ran and its average duration. Forced shows a plan pinned with sp_query_store_force_plan.",
  [prom(nameless("mssql_query_store_plan_avg_duration_seconds")), prom(nameless("mssql_query_store_plan_executions")), prom(nameless("mssql_query_store_plan_forced"))], 24, 6, {
    columns: { database: "Database", query_id: "Query id", plan_id: "Plan id", query: "Query", "Value #B": "Executions", "Value #A": "Avg duration", "Value #C": "Forced" },
    units: { "Avg duration": "s" }, decimals: { Executions: 0 }, widths: { Query: 420 }, sortBy: "Avg duration",
    mappings: { Forced: [{ type: "value", options: { 0: { text: "" }, 1: { text: "forced", color: "blue" } } }] },
  });

// ---------------------------------------------------------------------------------------------
row("Query plans (OpenTelemetry Collector)");
logTable("Plan warnings", "The plans of the top queries (db.server.query_plan), with what usually makes a plan slow pulled out of the XML: an implicit conversion that blocks a seek, a key lookup per row, a scan, a spill to tempdb, a missing index, a join with no predicate. Cost is the optimizer's estimate.",
  `${event("db.server.query_plan")} ${userDbs}`, 24, 9, {
    key: "sqlserver_query_hash",
    columns: { sqlserver_query_hash: "Query hash", db_namespace: "Database", plan_statement: "Statement", plan_cost: "Est. cost", plan_dop: "DOP",
      plan_implicit_conversion: "Implicit conversion", plan_key_lookup: "Key lookup", plan_scan: "Scan", plan_missing_index: "Missing index",
      plan_spill: "Spill", plan_no_join_predicate: "No join predicate" },
    mappings: Object.fromEntries(["Implicit conversion", "Key lookup", "Scan", "Missing index", "Spill", "No join predicate"].map((c) => [c, flag])),
    maxLines: 500,
  });
logs("Execution plans", "The plan XML itself (db.server.query_plan): match it to the table above by sqlserver_query_hash in the line's details. Save one as .sqlplan to open it graphically in SSMS or Azure Data Studio.",
  `${event("db.server.query_plan")} ${userDbs}`, 24, 9, 50);
logs("Procedure definitions", "The source of the procedures in the top list (db.server.procedure_definition).",
  event("db.server.procedure_definition"), 24, 8, 50);

// ---------------------------------------------------------------------------------------------
row("Indexes");
table("Missing-index suggestions", "mssql_missing_indexes: indexes the optimizer wanted, top 10 per database by estimated improvement. Overlapping suggestions are common: combine them, and weigh the write cost, before creating any.",
  [prom(nameless("mssql_missing_index_improvement")), prom(nameless("mssql_missing_index_uses_total")), prom(nameless("mssql_missing_index_avg_impact_percent"))], 14, 7, {
    columns: { database: "Database", table: "Table", equality_columns: "Equality", inequality_columns: "Inequality", included_columns: "Include",
      "Value #A": "Improvement", "Value #B": "Uses", "Value #C": "Avg impact" },
    units: { Improvement: "short", Uses: "short", "Avg impact": "percent" }, sortBy: "Improvement", decimals: { Uses: 0 },
  });
table("Unused indexes", "mssql_index_usage: indexes every write maintains but no query has read since SQL Server started. Candidates to drop, once the uptime covers a full business cycle.",
  [prom(nameless("mssql_unused_index_writes_total")), prom(nameless("mssql_unused_index_bytes"))], 10, 7, {
    columns: { database: "Database", table: "Table", index: "Index", "Value #A": "Writes", "Value #B": "Size" },
    units: { Writes: "short", Size: "bytes" }, sortBy: "Writes", decimals: { Writes: 0 },
  });

// ---------------------------------------------------------------------------------------------
row("Storage, I/O and backups");
table("Database size", "Data and log file sizes per database, and how much of the log is in use. A log that stays full is waiting on a log backup (full recovery) or a long transaction.",
  [prom(nameless("mssql_database_data_bytes")), prom(nameless("mssql_database_log_bytes")), prom(nameless("mssql_database_log_used_bytes"))], 8, 8, {
    columns: { database: "Database", "Value #A": "Data", "Value #B": "Log", "Log used": "Log used" },
    hide: ["Value #C"], calc: [["Log used", "Value #C", "/", "Value #B"]],
    units: { Data: "bytes", Log: "bytes", "Log used": "percentunit" }, sortBy: "Data",
  });
series("I/O latency", "Average time per read and per write, per database and file type (mssql_io_files): stall divided by count, so a gap where a file had no I/O. Log writes above a few ms slow every commit.",
  [prom('rate(mssql_io_file_read_stall_seconds[5m]) / rate(mssql_io_file_reads[5m])', { legendFormat: "{{db}} {{file_type}} read" }),
   prom('rate(mssql_io_file_write_stall_seconds[5m]) / rate(mssql_io_file_writes[5m])', { legendFormat: "{{db}} {{file_type}} write" })], 8, 8, { unit: "s", min: 0 });
series("tempdb", "tempdb space by use: temp tables (user objects), sorts and hashes (internal objects), row versions (version store).",
  [prom('mssql_tempdb_bytes{use!="free"}', { legendFormat: "{{use}}" })], 8, 8, { unit: "bytes", stack: true, min: 0 });
table("Last backup", "Time since each database's last backup of each type finished. Never backed up shows as never.",
  [prom("mssql_last_backup_age_seconds")], 20, 8, {
    columns: { database: "Database", type: "Type", Value: "Since last backup" },
    units: { "Since last backup": "dtdurations" }, sortBy: "Since last backup",
    mappings: { "Since last backup": [{ type: "value", options: { "-1": { text: "never", color: "red" } } }] },
  });
stat("Log growths", "Times a transaction log had to grow in the time range: each growth stalls writes; size the log so it doesn't have to.",
  "sum(increase(mssql_log_growths[$__range]))", 4, { decimals: 0, thresholds: [{ color: "green", value: null }, { color: "orange", value: 1 }] });

// ---------------------------------------------------------------------------------------------
row("SQL Server Agent jobs");
stat("Agent running", "Whether SQL Server Agent is running: if it isn't, no job runs, and nothing says so.", "mssql_agent_up", 4,
  { thresholds: [{ color: "red", value: null }, { color: "green", value: 1 }],
    mappings: [{ type: "value", options: { 0: { text: "stopped" }, 1: { text: "running" } } }] });
stat("Failing jobs", "Enabled jobs whose last run failed.", "count(mssql_agent_job_last_outcome == 0 and on(job_name) mssql_agent_job_enabled == 1) or vector(0)", 4,
  { decimals: 0, thresholds: red(1) });
const outcome = [{ type: "value", options: {
  1: { text: "succeeded", color: "green" }, 0: { text: "failed", color: "red" }, 2: { text: "retry", color: "orange" },
  3: { text: "canceled", color: "orange" }, 4: { text: "running", color: "blue" }, "-1": { text: "never ran" } } }];
table("Jobs", "mssql_agent: every job, its last outcome, how long ago its last run started and how long it took, and the failed runs still in its history.",
  [prom(nameless("mssql_agent_job_last_outcome")), prom(nameless("mssql_agent_job_last_run_age_seconds")),
   prom(nameless("mssql_agent_job_last_run_duration_seconds")), prom(nameless("mssql_agent_job_failed_runs")), prom(nameless("mssql_agent_job_enabled"))], 16, 7, {
    columns: { job_name: "Job", "Value #E": "Enabled", "Value #A": "Last outcome", "Value #B": "Last run", "Value #C": "Duration", "Value #D": "Failed runs" },
    units: { "Last run": "dtdurations", Duration: "s" }, decimals: { "Failed runs": 0 }, sortBy: "Failed runs",
    mappings: { "Last outcome": outcome, Enabled: [{ type: "value", options: { 0: { text: "disabled", color: "orange" }, 1: { text: "yes" } } }],
      "Last run": [{ type: "value", options: { "-1": { text: "never" } } }] },
  });

row("SQL Server error log (Linux compose stack)");
stat("Failed logins", "\"Login failed\" entries in the error log in the time range: a wrong password, a missing login, or someone guessing.",
  { datasource: L, expr: `sum(count_over_time(${event("db.server.errorlog")} |= "Login failed" [$__range]))`, queryType: "instant" }, 4,
  { decimals: 0, noValue: "0", thresholds: [{ color: "green", value: null }, { color: "orange", value: 1 }] });
logs("Error log", "SQL Server's own error log (event db.server.errorlog), read from the container's log directory: startup, recovery, failed logins, I/O and memory errors. Not collected from the Windows runs.",
  event("db.server.errorlog"), 20, 8, 500);

const dashboard = {
  uid: "sql-server-example", title: "SQL Server example", tags: ["sql-server"], timezone: "browser",
  schemaVersion: 41, version: 1, refresh: "30s", time: { from: "now-30m", to: "now" }, panels,
};
writeFileSync(new URL("./dashboards/sql-server.json", import.meta.url), JSON.stringify(dashboard, null, 2) + "\n");
console.log(`${panels.length} panels`);
