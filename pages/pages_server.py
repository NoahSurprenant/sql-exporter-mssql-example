"""A static server that behaves like GitHub Pages for missing files: serves the site's 404.html."""
import http.server, os, sys
class H(http.server.SimpleHTTPRequestHandler):
    def send_error(self, code, message=None, explain=None):
        page = os.path.join(os.getcwd(), "sql-exporter-mssql-example", "404.html")
        if code == 404 and os.path.exists(page):
            body = open(page, "rb").read()
            self.send_response(404); self.send_header("Content-Type", "text/html"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body)
        else:
            super().send_error(code, message, explain)
http.server.ThreadingHTTPServer(("", int(sys.argv[1])), H).serve_forever()
