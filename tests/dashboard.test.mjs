// Static checks of the Grafana dashboard: no SQL Server, Prometheus or Grafana needed, seconds to run.
//
//   node --test tests/*.test.mjs                 # PROMTOOL=/path/to/promtool also parses the PromQL
//
// tests/check_grafana.py runs every panel through a live Grafana, which needs the whole stack and a
// few minutes. These catch the mistakes that need neither, on every pull request: a committed
// dashboard the generator no longer produces, a panel off the grid or with a duplicate id, a data
// source no provisioned Grafana has, a query on a metric the collectors don't define (a renamed
// metric would otherwise just be an empty panel), and PromQL that doesn't parse.
//
// Node's built-in test runner, no dependencies: the dashboard's generator is already a Node module,
// and importing it gives the dashboard without writing the file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

import { dashboard as generated } from "../stack/grafana/dashboard.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const committed = JSON.parse(read("stack/grafana/dashboards/sql-server.json"));

// Every panel, rows' nested panels included.
const panels = committed.panels.flatMap((p) => [p, ...(p.panels ?? [])]);
const queried = panels.filter((p) => p.targets?.length);
const label = (panel) => `panel ${panel.id} "${panel.title}"`;

// The data sources stack/grafana/provisioning sets up: {uid: type}. The dashboard has no data source
// variables, so a fixed uid is right as long as provisioning gives every Grafana that uid.
function provisionedDatasources() {
  const sources = {};
  for (const entry of read("stack/grafana/provisioning/datasources/datasources.yaml").split(/^\s*- /m).slice(1)) {
    const uid = entry.match(/^\s*uid:\s*(\S+)/m)?.[1];
    const type = entry.match(/^\s*type:\s*(\S+)/m)?.[1];
    if (uid) sources[uid] = type;
  }
  return sources;
}

// Every metric_name in collectors/*.collector.yml, as tests/check_metrics.py reads them.
function collectorMetrics() {
  const metrics = new Set();
  for (const file of readdirSync(new URL("collectors/", root)).filter((f) => f.endsWith(".collector.yml"))) {
    for (const m of read(`collectors/${file}`).matchAll(/^\s*-\s*metric_name:\s*(\S+)/gm)) metrics.add(m[1]);
  }
  return metrics;
}
// Series every scrape gets besides the target's own: Prometheus adds these for each target
// (https://prometheus.io/docs/concepts/jobs_instances/#automatically-generated-labels-and-time-series),
// and sql_exporter reports its own up and scrape_duration_seconds per named target (sql_exporter.yml).
const SCRAPE_METRICS = ["up", "scrape_duration_seconds", "scrape_samples_scraped",
  "scrape_samples_post_metric_relabeling", "scrape_series_added"];

// Grafana's built-in variables, filled with plausible values so the query is plain PromQL.
// The dashboard defines no variables of its own; any other $ is a failure.
const VARIABLES = { __rate_interval: "1m", __interval: "15s", __range: "1h", __range_s: "3600", __interval_ms: "15000" };
function fill(expr) {
  return expr.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, braced, plain) => VARIABLES[braced ?? plain] ?? all);
}

// The metric names a PromQL expression selects. Strings, label matchers, range and subquery
// brackets and grouping label lists are removed first; what is left that looks like a name and
// isn't a function call, keyword or number is a metric.
const KEYWORDS = new Set(["and", "or", "unless", "by", "without", "on", "ignoring", "group_left", "group_right",
  "bool", "offset", "atan2", "inf", "nan", "start", "end"]);
function metricNames(expr) {
  const bare = expr
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""')
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, " ");
  const names = new Set();
  for (const m of bare.matchAll(/(?<![\w.:])([a-zA-Z_:][\w:]*)(\s*\()?/g)) {
    if (!m[2] && !KEYWORDS.has(m[1].toLowerCase())) names.add(m[1]);
  }
  return names;
}

const promTargets = queried.flatMap((panel) =>
  panel.targets.filter((t) => (t.datasource ?? panel.datasource)?.type === "prometheus").map((t) => ({ panel, target: t })));

test("the committed dashboard is what stack/grafana/dashboard.mjs generates", () => {
  assert.deepEqual(committed, JSON.parse(JSON.stringify(generated)),
    "stack/grafana/dashboards/sql-server.json is out of date: run `node stack/grafana/dashboard.mjs` and commit the result");
});

test("structure: a uid, unique panel ids, every panel on the 24-column grid", () => {
  assert.ok(committed.uid, "the dashboard has no uid");
  const seen = new Map();
  for (const panel of panels) {
    assert.ok(Number.isInteger(panel.id), `${label(panel)} has no id`);
    assert.ok(!seen.has(panel.id), `${label(panel)} has the same id as "${seen.get(panel.id)}"`);
    seen.set(panel.id, panel.title);
    const { x, y, w, h } = panel.gridPos ?? {};
    assert.ok([x, y, w, h].every(Number.isInteger) && x >= 0 && y >= 0 && w > 0 && h > 0,
      `${label(panel)} has no whole gridPos: ${JSON.stringify(panel.gridPos)}`);
    assert.ok(x + w <= 24, `${label(panel)} runs past column 24: x ${x} + w ${w}`);
  }
});

test("data sources: only the uids stack/grafana/provisioning sets up", () => {
  const sources = provisionedDatasources();
  assert.ok(Object.keys(sources).length, "no data sources found in datasources.yaml");
  assert.ok(!committed.templating?.list?.length, "the dashboard has variables now: check data source variables here too");
  for (const panel of panels) {
    for (const [where, ds] of [["panel", panel.datasource], ...(panel.targets ?? []).map((t) => [`target ${t.refId}`, t.datasource])]) {
      if (!ds) continue;
      assert.ok(Object.hasOwn(sources, ds.uid), `${label(panel)} ${where}: data source uid "${ds.uid}" is not provisioned (${Object.keys(sources).join(", ")})`);
      assert.equal(ds.type, sources[ds.uid], `${label(panel)} ${where}: data source "${ds.uid}" is a ${sources[ds.uid]}, not ${ds.type}`);
    }
  }
});

test("every metric a Prometheus query uses is a metric_name in collectors/", () => {
  const known = new Set([...collectorMetrics(), ...SCRAPE_METRICS]);
  assert.ok(promTargets.length, "no Prometheus queries found");
  const unknown = [];
  for (const { panel, target } of promTargets) {
    const names = metricNames(target.expr);
    assert.ok(names.size || /vector\(/.test(target.expr), `${label(panel)} ${target.refId}: no metric found in ${target.expr}`);
    for (const name of names) if (!known.has(name)) unknown.push(`${label(panel)} ${target.refId}: ${name}`);
  }
  assert.deepEqual(unknown, [], "metrics no collector defines:\n  " + unknown.join("\n  "));
});

test("the metric name check finds the metrics in a query", () => {
  assert.deepEqual([...metricNames(
    'sum by (db) (rate(a_total{x="b c", y=~"d|e"}[5m])) / on(db) group_left(z) b and c offset 1m or vector(0)',
  )].sort(), ["a_total", "b", "c"]);
});

test("Loki queries are not empty", () => {
  for (const panel of queried) {
    for (const target of panel.targets.filter((t) => (t.datasource ?? panel.datasource)?.type === "loki")) {
      assert.ok(target.expr?.trim(), `${label(panel)} ${target.refId}: empty Loki query`);
    }
  }
});

// promtool parses PromQL exactly as Prometheus does. Each panel is a rule group, so a failure names
// the panel. JSON is YAML, so the rules file needs no YAML library.
test("every Prometheus query parses (promtool)", { skip: !process.env.PROMTOOL && "PROMTOOL is not set" }, () => {
  const groups = new Map();
  for (const { panel, target } of promTargets) {
    const expr = fill(target.expr);
    assert.ok(!expr.includes("$"), `${label(panel)} ${target.refId}: unknown variable in ${expr}`);
    const name = `${label(panel)}`;
    if (!groups.has(name)) groups.set(name, { name, rules: [] });
    groups.get(name).rules.push({ record: `panel_${panel.id}_${target.refId}`, expr });
  }
  const rules = JSON.stringify({ groups: [...groups.values()] }, null, 2);
  const run = spawnSync(process.env.PROMTOOL, ["check", "rules", "--lint=none"], { input: rules, encoding: "utf8" });
  assert.equal(run.error, undefined, `could not run ${process.env.PROMTOOL}: ${run.error}`);
  assert.equal(run.status, 0, `promtool check rules failed:\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout, new RegExp(`SUCCESS: ${promTargets.length} rules found`));
});
