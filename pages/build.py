"""Turns the recorded index.html into the static page: registers sw.js before Grafana boots."""
import sys
# python pages/build.py <site dir> <snapshot key>
site, key, base = sys.argv[1], sys.argv[2], "/sql-exporter-mssql-example/"
html = open(f"{site}/index.html").read()
boot = f"""<script>
(function () {{
  var base = "{base}";
  // Open on the snapshot, whatever page of the site was asked for.
  if (location.pathname === base || location.pathname === base + "index.html") {{
    history.replaceState(null, "", base + "dashboard/snapshot/{key}?orgId=1");
  }}
  // First visit: no service worker yet, so Grafana would reach for a backend that isn't there.
  // Stop loading, install the worker, and reload under it.
  if (!navigator.serviceWorker.controller) {{
    window.stop();
    navigator.serviceWorker.register(base + "sw.js", {{ scope: base }})
      .then(function () {{ return navigator.serviceWorker.ready; }})
      .then(function () {{ location.replace(base); }});
  }}
}})();
</script>"""
html = html.replace("<head>", "<head>" + boot, 1)
open(f"{site}/index.html", "w").write(html)
open(f"{site}/404.html", "w").write(html)
print("ok", len(html))
