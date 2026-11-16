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

import { text as generatedText } from "../stack/grafana/dashboard.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const committed = JSON.parse(read("stack/grafana/dashboards/sql-server.json"));

// Every panel, rows' nested panels included.
const panels = committed.panels.flatMap((p) => [p, ...(p.panels ?? [])]);
const queried = panels.filter((p) => p.targets?.length);
const label = (panel) => `panel ${panel.id} "${panel.title}"`;

// The data sources stack/grafana/provisioning sets up, each as its scalar keys ({name, uid, type,
// isDefault, ...}, all strings). The dashboard has no data source variables, so a fixed uid is
// right as long as provisioning gives every Grafana that uid.
//
// Node has no YAML parser and the tests take no packages, so this reads the one shape a Grafana
// provisioning file has: the items of the top-level `datasources:` block list, and in each item
// only its own `key: value` scalars (nested maps and lists such as jsonData are skipped). Values
// may be quoted ("..." or '...') and may have a trailing # comment. Flow style ([...], {...}) isn't
// read; the file doesn't use it, and the "no data sources" assertion would catch it if it did.
function yamlScalar(text) {
  const quoted = text.match(/^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/);
  if (quoted) return quoted[1] !== undefined ? JSON.parse(`"${quoted[1]}"`) : quoted[2].replaceAll("''", "'");
  return text.replace(/(^|\s)#.*$/, "").trim();
}
function parseDatasources(text) {
  const entries = [];
  let inList = false;
  let itemIndent = -1;
  let keyIndent = -1;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line) || line.startsWith("---")) continue;
    const indent = line.search(/\S/);
    if (indent === 0) { inList = /^datasources:\s*(#.*)?$/.test(line); itemIndent = -1; continue; }
    if (!inList) continue;
    // A new item: "- " at the list's indentation; its first key starts on the same line.
    const item = line.match(/^\s*-(\s+)(.*)$/);
    let rest = line.trimStart();
    let restIndent = indent;
    if (item && (itemIndent < 0 || indent === itemIndent)) {
      itemIndent = indent;
      keyIndent = indent + 1 + item[1].length;
      entries.push({});
      rest = item[2];
      restIndent = keyIndent;
    }
    const key = restIndent === keyIndent && rest.match(/^([\w.-]+):(?:\s+(.*))?$/);
    if (key && entries.length) {
      const value = yamlScalar(key[2] ?? "");
      if (value !== "") entries.at(-1)[key[1]] = value;
    }
  }
  return entries.filter((e) => e.uid);
}

test("the provisioning parser reads quoted values, comments and nested lists", () => {
  const yaml = [
    "apiVersion: 1",
    "# a comment: with a colon",
    "datasources:",
    "  - name: Loki",
    '    type: "loki"   # quoted, with a comment',
    "    uid: 'loki'",
    "    jsonData:",
    "      derivedFields:",
    "        - name: trace",
    "          type: not-a-datasource",
    "          uid: not-a-datasource",
    "    isDefault: false",
    "",
    "  -   name: Prometheus",
    '      uid: "prom#1"',
    "      type: prometheus # the default",
    "      isDefault: true",
    "deleteDatasources:",
    "  - name: Old",
    "    uid: old",
  ].join("\n");
  assert.deepEqual(parseDatasources(yaml).map(({ uid, type, isDefault }) => ({ uid, type, isDefault })), [
    { uid: "loki", type: "loki", isDefault: "false" },
    { uid: "prom#1", type: "prometheus", isDefault: "true" },
  ]);
});

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
// Grafana variable references that are not one of VARIABLES, in Grafana's three syntaxes ($name,
// ${name}, ${name:format}, [[name]]; its own pattern in public/app/features/variables/utils.ts).
// Any other $ is PromQL's own: a regex anchor, or a capture group in label_replace ("$1", "${1}"),
// which Grafana leaves alone because no variable has a number for a name.
const VARIABLE = /\$(\w+)|\[\[(\w+?)(?::\w+)?\]\]|\$\{(\w+)(?:\.[^:^}]+)?(?::[^}]+)?\}/g;
function unknownVariables(expr) {
  return [...expr.matchAll(VARIABLE)]
    .filter((m) => { const name = m[1] ?? m[2] ?? m[3]; return !/^\d+$/.test(name) && !Object.hasOwn(VARIABLES, name); })
    .map((m) => m[0]);
}

test("the variable check flags unknown Grafana variables, not every $", () => {
  assert.deepEqual(unknownVariables('label_replace(up, "db", "$1", "instance", "(.*)")'), []);
  assert.deepEqual(unknownVariables('label_replace(up, "db", "${1}x", "instance", "(.*)")'), []);
  assert.deepEqual(unknownVariables('up{db=~"Example.*$"}'), []);
  assert.deepEqual(unknownVariables("rate(a[$__rate_interval]) * ${__interval_ms}"), []);
  assert.deepEqual(unknownVariables('a{db="$db"} / b{x="${server}"} / c{y="[[old]]"}'), ["$db", "${server}", "[[old]]"]);
  assert.deepEqual(unknownVariables('a{db="${db:regex}"}'), ["${db:regex}"]);
});

// The metric names a PromQL expression selects. Strings and # comments (in one pass, so a quote in
// a comment or a # in a string is no problem), Grafana variables, label matchers, range and subquery
// brackets and grouping label lists (PromQL keywords are case-insensitive) are removed first; what
// is left that looks like a name and isn't a function call, keyword or number is a metric.
const KEYWORDS = new Set(["and", "or", "unless", "by", "without", "on", "ignoring", "group_left", "group_right",
  "bool", "offset", "atan2", "inf", "nan", "start", "end"]);
function metricNames(expr) {
  const bare = expr
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|#.*/g, (m) => (m[0] === "#" ? " " : '""'))
    .replace(/\$\{[^}]*\}|\$\w+|\[\[[^\]]*\]\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/gi, " ");
  const names = new Set();
  for (const m of bare.matchAll(/(?<![\w.:])([a-zA-Z_:][\w:]*)(\s*\()?/g)) {
    if (!m[2] && !KEYWORDS.has(m[1].toLowerCase())) names.add(m[1]);
  }
  return names;
}

// The data source a target queries, as Grafana picks it: the target's, else the panel's, else the
// one provisioning marks isDefault. A reference may give only the uid; its type is then the
// provisioned one. Undefined when there is none of the three.
function datasourceOf(panel, target, sources) {
  const ref = target.datasource ?? panel.datasource ?? sources.find((s) => s.isDefault === "true");
  return ref && { uid: ref.uid, type: ref.type ?? sources.find((s) => s.uid === ref.uid)?.type };
}
function targetsOn(type, panels, sources) {
  return panels.flatMap((panel) => (panel.targets ?? [])
    .filter((t) => datasourceOf(panel, t, sources)?.type === type).map((target) => ({ panel, target })));
}

test("a query without a data source goes to the provisioned default", () => {
  const sources = [{ uid: "prom", type: "prometheus", isDefault: "true" }, { uid: "logs", type: "loki" }];
  const panels = [
    { id: 1, targets: [{ refId: "A", expr: "up" }] },
    { id: 2, datasource: { type: "loki", uid: "logs" }, targets: [{ refId: "A", expr: '{a="b"}' }] },
    { id: 3, targets: [{ refId: "A", datasource: { uid: "prom" }, expr: "x" }] },
  ];
  const ids = (type) => targetsOn(type, panels, sources).map(({ panel }) => panel.id);
  assert.deepEqual(ids("prometheus"), [1, 3]);
  assert.deepEqual(ids("loki"), [2]);
});

const datasources = parseDatasources(read("stack/grafana/provisioning/datasources/datasources.yaml"));
const promTargets = targetsOn("prometheus", queried, datasources);

// The text, not the parsed JSON: a reformatted or reordered file is one the generator would rewrite.
const upToDate = (fileText) => fileText === generatedText;

test("the up-to-date check compares the text the generator writes", () => {
  const text = read("stack/grafana/dashboards/sql-server.json");
  assert.ok(!upToDate(JSON.stringify(JSON.parse(text))), "a minified copy passed");
  assert.ok(!upToDate(text.trimEnd()), "a copy without the final newline passed");
  const { uid, ...rest } = JSON.parse(text);
  assert.ok(!upToDate(JSON.stringify({ ...rest, uid }, null, 2) + "\n"), "a copy with its keys reordered passed");
});

test("importing the generator works when argv[1] is no file (a script piped to node -)", () => {
  const generator = new URL("stack/grafana/dashboard.mjs", root).href;
  const run = spawnSync(process.execPath, ["--input-type=module", "-"], {
    input: `import { text } from ${JSON.stringify(generator)}; process.stdout.write(String(text.length));`,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `importing dashboard.mjs from node - failed:\n${run.stderr}`);
  assert.equal(run.stdout, String(generatedText.length));
});

test("the committed dashboard is what stack/grafana/dashboard.mjs generates", () => {
  assert.ok(upToDate(read("stack/grafana/dashboards/sql-server.json")),
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
  const sources = Object.fromEntries(datasources.map((d) => [d.uid, d.type]));
  assert.ok(Object.keys(sources).length, "no data sources found in datasources.yaml");
  assert.ok(!committed.templating?.list?.length, "the dashboard has variables now: check data source variables here too");
  for (const panel of panels) {
    for (const [where, ds] of [["panel", panel.datasource], ...(panel.targets ?? []).map((t) => [`target ${t.refId}`, t.datasource])]) {
      if (!ds) continue;
      assert.ok(Object.hasOwn(sources, ds.uid), `${label(panel)} ${where}: data source uid "${ds.uid}" is not provisioned (${Object.keys(sources).join(", ")})`);
      assert.equal(ds.type, sources[ds.uid], `${label(panel)} ${where}: data source "${ds.uid}" is a ${sources[ds.uid]}, not ${ds.type}`);
    }
    for (const target of panel.targets ?? []) {
      assert.ok(datasourceOf(panel, target, datasources)?.type,
        `${label(panel)} target ${target.refId}: no data source, and none is provisioned as the default`);
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

test("the metric name check skips variables, comments and upper-case grouping lists", () => {
  const names = (expr) => [...metricNames(expr)].sort();
  assert.deepEqual(names("sum(increase(a[$__range])) / $__range_s"), ["a"]);
  assert.deepEqual(names("a * ${__interval_ms} / [[__interval_ms]]"), ["a"]);
  assert.deepEqual(names("a # rate of b, isn't it\n+ c"), ["a", "c"]);
  assert.deepEqual(names('sum BY (db) (x) / ON (db) GROUP_LEFT (z) y{l="#"}'), ["x", "y"]);
});

test("Loki queries are not empty", () => {
  for (const { panel, target } of targetsOn("loki", queried, datasources)) {
    assert.ok(target.expr?.trim(), `${label(panel)} ${target.refId}: empty Loki query`);
  }
});

// promtool parses PromQL exactly as Prometheus does. Each panel is a rule group, so a failure names
// the panel. JSON is YAML, so the rules file needs no YAML library.
test("every Prometheus query parses (promtool)", { skip: !process.env.PROMTOOL && "PROMTOOL is not set" }, () => {
  const groups = new Map();
  for (const { panel, target } of promTargets) {
    const expr = fill(target.expr);
    assert.deepEqual(unknownVariables(target.expr), [], `${label(panel)} ${target.refId}: unknown variable in ${target.expr}`);
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
