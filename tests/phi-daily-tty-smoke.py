#!/usr/bin/env python3
"""Measure the candidate's actual REPL prompt in a disposable, networkless TTY."""

import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time


SOURCE = Path(os.environ.get("PHI_TTY_SOURCE", Path(__file__).resolve().parents[1]))
DEPENDENCIES = Path(__file__).resolve().parents[1]
NODE_ROOT = Path("/home/tasso/.local/share/pi-node/node-v22.23.2-linux-x64")


def command(home):
    args = [
        "bwrap", "--die-with-parent", "--ro-bind", "/usr", "/usr",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
        "--symlink", "usr/lib64", "/lib64", "--dir", "/home",
        "--dir", "/home/tasso", "--dir", "/home/tasso/.local",
        "--dir", "/home/tasso/.local/share", "--dir", "/home/tasso/.local/share/pi-node",
        "--ro-bind", str(NODE_ROOT), str(NODE_ROOT), "--ro-bind", str(SOURCE), "/phi",
    ]
    if SOURCE != DEPENDENCIES:
        for package in ("mcp", "lsp"):
            args += ["--ro-bind", str(DEPENDENCIES / "runtime" / package / "node_modules"),
                     "/phi/runtime/" + package + "/node_modules"]
    return args + [
        "--bind", str(home), "/home/phi", "--proc", "/proc", "--dev", "/dev",
        "--tmpfs", "/tmp", "--unshare-net", "--unshare-pid", "--chdir", "/phi", "--clearenv",
        "--setenv", "HOME", "/home/phi", "--setenv", "PI_CODING_AGENT_DIR", "/home/phi/.pi/agent",
        "--setenv", "XDG_CONFIG_HOME", "/home/phi/.config", "--setenv", "XDG_STATE_HOME", "/home/phi/.local/state",
        "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "TERM", "xterm-256color",
        "--setenv", "COLORTERM", "truecolor", "--setenv", "LANG", "C.UTF-8",
        "--setenv", "PI_OFFLINE", "1",
        "--setenv", "PI_OVERDRIVE_ROUTING_AUDIT_KEY", "fixture-only-not-a-secret",
        str(NODE_ROOT / "bin/node"),
        "/phi/bin/phi.mjs", "--offline", "--no-session", "--no-context-files",
    ]


def run_once(home, width, timeout=12, action=None):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, width, 0, 0))
    started = time.monotonic()
    process = subprocess.Popen(command(home), stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True, close_fds=True)
    os.close(slave)
    output = bytearray()
    prompt_ms = None
    action_sent = False
    try:
        while time.monotonic() - started < timeout:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > 1_000_000:
                    raise RuntimeError("tty_output_over_limit")
                clean_so_far = re.sub(rb"\x1b\[[0-9;?]*[ -/]*[@-~]", b"", output)
                if prompt_ms is None and re.search(rb"MCP [0-9]+/[0-9]+ memory: lazy", clean_so_far) and b"Phi" in clean_so_far:
                    prompt_ms = round((time.monotonic() - started) * 1000)
                    if action is None:
                        os.killpg(process.pid, signal.SIGTERM)
                    else:
                        os.write(master, action.encode() + b"\r")
                        action_sent = True
                if action_sent and b"provider_registry_selector_not_found" in clean_so_far:
                    os.killpg(process.pid, signal.SIGTERM)
            if process.poll() is not None:
                break
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    finally:
        os.close(master)
    text = output.decode("utf-8", "replace")
    plain = re.sub(r"\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)
    plain = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", plain)
    return {
        "width": width, "promptMs": prompt_ms, "exit": process.returncode,
        "phiHeader": "Phi 1.0.0" in plain or "PHI" in plain,
        "modelLabel": bool(re.search(r"gpt-6-sol|deepseek-v4", plain)),
        "violetAnsi": "38;2;167;139;250" in text or "38;2;196;181;253" in text,
        "errorRedAnsi": "38;2;242;154;166" in text,
        "providerError": "provider_registry_selector_too_broad" in plain,
        "selectorNotFound": "provider_registry_selector_not_found" in plain,
        "optionalDegraded": "Phi optional" in plain,
        "optionalLines": [line[:100] for line in plain.splitlines() if line.startswith("Phi optional ")][:4],
        "statusBar": bool(re.search(r"[0-9.]+%/[0-9]+[kM]? \(auto\)", plain)),
        "sample": [line[:100] for line in plain.splitlines() if "Phi 1.0.0" in line or "Second Brain" in line or "MCP 0/1" in line or "gpt-6-sol" in line][:6],
        "failureLines": [line[:120] for line in plain.splitlines() if line.strip()][:5] if prompt_ms is None else [],
    }


def main():
    if not shutil.which("bwrap") or not NODE_ROOT.is_dir():
        raise SystemExit("isolated_tty_prerequisites_missing")
    with tempfile.TemporaryDirectory(prefix="phi-daily-tty-") as root:
        home = Path(root)
        agent = home / ".pi/agent"
        agent.mkdir(parents=True, mode=0o700)
        (agent / "settings.json").write_text(json.dumps({
            "packages": ["/phi", "/phi/tests/fixtures/deterministic-routing-provider.ts"], "defaultProvider": "openai-codex",
            "defaultModel": "gpt-6-sol", "defaultThinkingLevel": "medium",
        }))
        (agent / "settings.json").chmod(0o600)
        results = [run_once(home, width) for width in (100, 100, 100, 40)]
        error_result = run_once(home, 100, action="/models --capabilities --provider nonexistent-fixture")
        print(json.dumps({"isolation": "bwrap_readonly_source_private_home_no_network_no_host_bus",
                          "results": results, "errorProbe": error_result}, indent=2))
        if (any(item["promptMs"] is None or item["exit"] != -15 or any("omniroute" in line for line in item["optionalLines"]) or not all(item[key] for key in ("phiHeader", "modelLabel", "violetAnsi", "statusBar")) for item in results)
                or not error_result["selectorNotFound"] or not error_result["errorRedAnsi"]):
            raise SystemExit(1)


if __name__ == "__main__":
    main()
