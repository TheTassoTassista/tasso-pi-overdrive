#!/usr/bin/env python3
"""Single-client, networkless browser worker. Only its parent owns stdin/stdout."""

import base64
import hashlib
import http.server
import json
import os
import pathlib
import stat as stat_module
import subprocess
import sys
import threading


SESSION = os.environ["OVERDRIVE_BROWSER_SESSION"]
PORT = int(os.environ["OVERDRIVE_BROWSER_PORT"])
ROOT = pathlib.Path("/fixture/index.html")
CAPTURE = pathlib.Path("/tmp/browser-capture.png")
PNG = b"\x89PNG\r\n\x1a\n"
MAX_OUTPUT = 32768
MAX_IMAGE = 4 * 1024 * 1024


def chromium_identity():
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            arguments = (entry / "cmdline").read_bytes().split(b"\0")
            if not arguments or arguments[0] != b"/opt/chrome/chrome" or any(part.startswith(b"--type=") for part in arguments):
                continue
            proc_stat = (entry / "stat").read_text(encoding="ascii")
            start_ticks = proc_stat[proc_stat.rfind(")") + 1:].strip().split()[19]
            return {"pid": int(entry.name), "startTicks": start_ticks}
        except (FileNotFoundError, PermissionError, IndexError, ValueError):
            continue
    return None


def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/":
            self.send_error(404)
            return
        data = ROOT.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def command(request):
    action = request.get("action")
    timeout = request.get("timeoutMs", 15000)
    if type(timeout) is not int or not 100 <= timeout <= 120000:
        raise ValueError("timeout rejected")
    selector = request.get("selector")
    value = request.get("value")
    prefix = ["/opt/agent-browser/agent-browser", "--session", SESSION]
    if action == "open":
        args = prefix + ["--profile", "/profile", "open", f"http://127.0.0.1:{PORT}/"]
    elif action == "snapshot" and value in ("-i", "--compact"):
        args = prefix + ["snapshot", value]
    elif action in ("click", "fill", "get_text") and isinstance(selector, str) and (selector.startswith("#") or selector.startswith("@e")) and len(selector) <= 70:
        args = prefix + ({"click": ["click", selector], "fill": ["fill", selector, value], "get_text": ["get", "text", selector]}[action])
        if action == "fill" and (not isinstance(value, str) or len(value) > 2000):
            raise ValueError("fill rejected")
    elif action == "wait_text" and isinstance(value, str) and 0 < len(value) <= 256:
        args = prefix + ["wait", "--text", value]
    elif action in ("get_title", "get_url", "close"):
        args = prefix + ({"get_title": ["get", "title"], "get_url": ["get", "url"], "close": ["close"]}[action])
    elif action == "screenshot":
        if CAPTURE.exists() or CAPTURE.is_symlink():
            raise ValueError("capture already exists")
        args = prefix + ["screenshot", str(CAPTURE)]
    else:
        raise ValueError("action rejected")
    result = subprocess.run(args, capture_output=True, timeout=timeout / 1000, check=False)
    output = (result.stdout + result.stderr).decode("utf-8", errors="replace")[:MAX_OUTPUT]
    if result.returncode != 0:
        raise RuntimeError(f"browser command failed ({result.returncode}): {output[:1000]}")
    answer = {"ok": True, "action": action, "text": output, "networkNamespace": os.readlink("/proc/self/ns/net"), "chromiumIdentity": chromium_identity()}
    if action == "screenshot":
        descriptor = os.open(CAPTURE, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            stat = os.fstat(descriptor)
            if not stat_module.S_ISREG(stat.st_mode) or stat.st_nlink != 1 or not 8 <= stat.st_size <= MAX_IMAGE:
                raise ValueError("capture identity rejected")
            data = os.read(descriptor, MAX_IMAGE + 1)
            if len(data) != stat.st_size or not data.startswith(PNG):
                raise ValueError("capture contents rejected")
            answer["image"] = base64.b64encode(data).decode("ascii")
            answer["sha256"] = hashlib.sha256(data).hexdigest()
            answer["bytes"] = len(data)
        finally:
            os.close(descriptor)
            CAPTURE.unlink(missing_ok=True)
    return answer


def main():
    server = http.server.HTTPServer(("127.0.0.1", PORT), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    send({
        "ready": True,
        "networkNamespace": os.readlink("/proc/self/ns/net"),
        "pid": os.getpid(),
        "fixturePort": PORT,
        "ambientSecrets": any(("KEY" in key or "TOKEN" in key or "SECRET" in key or "PASSWORD" in key) for key in os.environ),
        "hostHomeVisible": any(entry.name != "sandbox" for entry in pathlib.Path("/home").iterdir()),
    })
    try:
        for raw in sys.stdin.buffer:
            if len(raw) > 8192:
                send({"ok": False, "error": "request too large"})
                break
            try:
                request = json.loads(raw)
                if not isinstance(request, dict) or set(request) - {"action", "selector", "value", "timeoutMs"}:
                    raise ValueError("request shape rejected")
                response = command(request)
                send(response)
                if request.get("action") == "close":
                    break
            except Exception as error:
                send({"ok": False, "error": f"{type(error).__name__}: {str(error)[:1000]}"})
                break
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
