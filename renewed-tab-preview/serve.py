"""Serve the Renewed Tab preview and its private PageAgo widget on loopback."""

import argparse
import mimetypes
import os
import secrets
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


PREVIEW = Path(__file__).resolve().parents[1] / "output/private/renewed-tab"
# Windows registry associations can report JavaScript as text/plain.
WEB_TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
             ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".ttf": "font/ttf"}
HOST_POLICY = (
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
    "frame-src 'self'; frame-ancestors 'none'; worker-src 'none'; "
    "base-uri 'self'; object-src 'none'; form-action https:"
)
WIDGET_POLICY = (
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "img-src data:; connect-src 'none'; frame-ancestors 'self'; "
    "form-action 'none'; base-uri 'none'; object-src 'none'"
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8794)
    parser.add_argument("--site", type=Path, default=PREVIEW / "site")
    parser.add_argument("--widget", type=Path, default=PREVIEW / "widget.html")
    parser.add_argument("--background", type=Path, default=Path(os.getenv("WINDIR", "C:/Windows")) /
                        "Web/Wallpaper/ThemeC/img31.jpg")
    args = parser.parse_args()
    site = args.site.resolve()
    if not (site / "index.html").is_file() or not args.widget.is_file():
        parser.error("Prepare the local Renewed Tab site and build widget.html before starting.")
    session = secrets.token_urlsafe(32)
    cookie_name = f"daytrace_preview_{args.port}"
    origin_host = f"127.0.0.1:{args.port}"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.serve(include_body=True)

        def do_HEAD(self):
            self.serve(include_body=False)

        def serve(self, include_body):
            if self.headers.get("Host") != origin_host:
                self.send_error(403)
                return
            route = unquote(urlsplit(self.path).path)
            policy = HOST_POLICY
            is_home = route in {"/", "/index.html"}
            if route.rstrip("/") == "/widget":
                cookies = SimpleCookie()
                try:
                    cookies.load(self.headers.get("Cookie", ""))
                except CookieError:
                    pass
                if cookie_name not in cookies or not secrets.compare_digest(
                    cookies[cookie_name].value, session
                ):
                    self.send_error(403)
                    return
                file = args.widget
                policy = WIDGET_POLICY
            elif route == "/background.jpg":
                file = args.background
            else:
                file = (site / ("index.html" if is_home else route.lstrip("/"))).resolve()
                if not file.is_relative_to(site):
                    self.send_error(404)
                    return
            if not file.is_file():
                self.send_error(404)
                return
            self.send_response(200)
            media_type = WEB_TYPES.get(file.suffix.lower()) or mimetypes.guess_type(file.name)[0]
            self.send_header("Content-Type", media_type or "application/octet-stream")
            self.send_header("Content-Length", str(file.stat().st_size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", policy)
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            if is_home:
                self.send_header("Set-Cookie", f"{cookie_name}={session}; Path=/widget; HttpOnly; SameSite=Strict")
            self.end_headers()
            if include_body:
                try:
                    self.wfile.write(file.read_bytes())
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        print(f"Renewed Tab with PageAgo at http://{origin_host}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
