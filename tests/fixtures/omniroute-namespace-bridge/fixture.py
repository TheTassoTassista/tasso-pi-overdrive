#!/usr/bin/python3
"""Credential-free backend for the uninstalled namespace-bridge experiment."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/__phi_bridge_probe":
            self.send_error(404)
            return
        body = json.dumps({"fixture": "phi-namespace-bridge-v1", "pid": os.getpid()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 20128), Handler).serve_forever()
