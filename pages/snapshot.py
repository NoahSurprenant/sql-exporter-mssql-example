"""python pages/snapshot.py <grafana url> <dashboard json>

Builds a Grafana snapshot of the example dashboard through the API: each panel's query runs
through /api/ds/query, its frames are stored in the panel as snapshotData, and the result is saved
with POST /api/snapshots. Prints the snapshot key."""
import datetime, json, sys, urllib.request

base = sys.argv[1].rstrip("/")
# Creating a snapshot needs a signed-in user; anonymous viewers can't. admin:admin is the
# throwaway stack's default.
AUTH = "Basic YWRtaW46YWRtaW4="
# Minutes the snapshot covers: about as long as the CI job has been collecting.
WINDOW = 15
dashboard = json.load(open(sys.argv[2]))

def call(path, body=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json", "Authorization": AUTH})
    return json.load(urllib.request.urlopen(req, timeout=60))

def to_dto(frame):
    schema, data = frame["schema"], frame.get("data", {"values": []})
    fields = []
    for i, f in enumerate(schema["fields"]):
        field = {k: v for k, v in f.items() if k in ("name", "type", "config", "labels", "typeInfo")}
        field["values"] = data["values"][i] if i < len(data["values"]) else []
        fields.append(field)
    return {"name": schema.get("name"), "refId": schema.get("refId"), "meta": schema.get("meta", {}), "fields": fields}

def as_table(frames, panel):
    """One table frame from per-series instant results, columns named as the panel's organize
    step names them: a live Prometheus panel builds this table in the browser, a snapshot doesn't."""
    org = next(t for t in panel.get("transformations", []) if t["id"] == "organize")["options"]
    hide, rename = org.get("excludeByName", {}), org.get("renameByName", {})
    rows = []
    for f in frames:
        value = next(x for x in f["fields"] if x["type"] == "number")
        rows.append((value.get("labels") or {}, value["values"][-1] if value["values"] else None))
    keys = [k for k in dict.fromkeys(k for labels, _ in rows for k in labels) if not hide.get(k)]
    fields = [{"name": rename.get(k, k), "type": "string", "config": {}, "values": [l.get(k, "") for l, _ in rows]} for k in keys]
    fields.append({"name": rename["Value"], "type": "number", "config": {}, "values": [v for _, v in rows]})
    return {"refId": "A", "meta": {}, "fields": fields}

for panel in dashboard["panels"]:
    if not panel.get("targets"):
        continue
    q = dict(panel["targets"][0], refId="A", maxDataPoints=500, intervalMs=15000)
    if panel["datasource"]["type"] == "loki":
        q["queryType"] = "range"
    res = call("/api/ds/query", {"queries": [q], "from": f"now-{WINDOW}m", "to": "now"})["results"]["A"]
    frames = [to_dto(f) for f in res.get("frames", [])]
    if panel["type"] == "table":
        frames = [as_table(frames, panel)]
    panel["snapshotData"] = frames
    print(panel["title"], sum(len(f["fields"][0]["values"]) if f["fields"] else 0 for f in panel["snapshotData"]), file=sys.stderr)

dashboard.pop("id", None)
# Fixed, not relative: a snapshot looked at next week must still show the window it was taken in.
end = datetime.datetime.now(datetime.timezone.utc)
dashboard["time"] = {"from": (end - datetime.timedelta(minutes=WINDOW)).isoformat(), "to": end.isoformat()}
dashboard["refresh"] = ""
out = call("/api/snapshots", {"dashboard": dashboard, "name": "SQL Server example", "expires": 0})
print(out["key"])
