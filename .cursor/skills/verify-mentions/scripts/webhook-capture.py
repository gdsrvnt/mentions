#!/usr/bin/env python3
"""Local stand-in for the Grok Bot webhook routine.

Listens on 127.0.0.1, records every request as one JSON line, and answers the
way the routine does: 200 when the auth header matches, 401 "Invalid API key"
when it does not. Run with `python3 -I` so nothing is imported from the cwd.

usage: webhook-capture.py --port-file FILE --out FILE [--require-header 'Name: value'] [--status CODE]
"""

import argparse
import hashlib
import json
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port-file", required=True, help="write the bound port here once listening")
    parser.add_argument("--out", required=True, help="append one JSON object per request")
    parser.add_argument("--require-header", help="exact header line the routine expects, e.g. 'Authorization: Bearer k'")
    parser.add_argument("--status", type=int, default=200, help="status for accepted requests (default 200)")
    args = parser.parse_args()

    required = None
    if args.require_header:
        name, _, value = args.require_header.partition(":")
        required = (name.strip().lower(), value.strip())

    class Handler(BaseHTTPRequestHandler):
        def _handle(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                body = json.loads(raw) if raw else None
            except ValueError:
                body = None
            matched = None
            if required is not None:
                matched = self.headers.get(required[0], "").strip() == required[1]
            status = args.status if matched in (None, True) else 401
            record = {
                "method": self.command,
                "path": self.path,
                "headers": {k: v for k, v in self.headers.items()},
                "body_bytes": len(raw),
                "body_sha256": hashlib.sha256(raw).hexdigest(),
                "body_json_keys": sorted(body.keys()) if isinstance(body, dict) else None,
                "event_name": body.get("event_name") if isinstance(body, dict) else None,
                "payload_keys": sorted(body["payload"].keys()) if isinstance(body, dict) and isinstance(body.get("payload"), dict) else None,
                "auth_matched": matched,
                "status": status,
            }
            with open(args.out, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record) + "\n")
            reply = b'{"ok":true}' if status < 400 else b'{"error":"Invalid API key"}'
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

        do_POST = _handle
        do_GET = _handle
        do_PUT = _handle

        def log_message(self, fmt: str, *rest: object) -> None:
            sys.stderr.write("webhook-capture: " + (fmt % rest) + "\n")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    def stop(*_: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    with open(args.port_file, "w", encoding="utf-8") as fh:
        fh.write(str(server.server_address[1]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
