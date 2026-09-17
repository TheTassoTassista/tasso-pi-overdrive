#!/usr/bin/python3
"""Minimal persistent Python kernel for the Pi Overdrive private sandbox."""

from __future__ import annotations

import ast
import builtins
import io
import json
import os
import resource
import sys
import time
from contextlib import redirect_stderr, redirect_stdout


_WIRE = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", errors="backslashreplace", buffering=1)
_NULL = os.open("/dev/null", os.O_WRONLY)
os.dup2(_NULL, sys.stdout.fileno())
os.close(_NULL)

_MAX_ADDRESS_SPACE = 256 * 1024 * 1024
_MAX_FILE_BYTES = 16 * 1024 * 1024
for _limit, _value in (
    (resource.RLIMIT_AS, _MAX_ADDRESS_SPACE),
    (resource.RLIMIT_CORE, 0),
    (resource.RLIMIT_FSIZE, _MAX_FILE_BYTES),
    (resource.RLIMIT_NOFILE, 64),
    (resource.RLIMIT_NPROC, 0),
):
    try:
        resource.setrlimit(_limit, (_value, _value))
    except (OSError, ValueError):
        pass


class _BoundedText(io.TextIOBase):
    def __init__(self, maximum: int) -> None:
        super().__init__()
        self.maximum = maximum
        self.data = bytearray()
        self.truncated = False

    def writable(self) -> bool:
        return True

    def write(self, value: object) -> int:
        text = value if isinstance(value, str) else str(value)
        encoded = text.encode("utf-8", errors="replace")
        remaining = max(0, self.maximum - len(self.data))
        if remaining:
            self.data.extend(encoded[:remaining])
        if len(encoded) > remaining:
            self.truncated = True
        return len(text)

    def text(self) -> str:
        return bytes(self.data).decode("utf-8", errors="replace")


_ALLOWED_IMPORTS = frozenset(
    {
        "ast",
        "base64",
        "collections",
        "csv",
        "dataclasses",
        "datetime",
        "decimal",
        "enum",
        "fractions",
        "functools",
        "hashlib",
        "heapq",
        "html",
        "io",
        "itertools",
        "json",
        "math",
        "operator",
        "pprint",
        "re",
        "statistics",
        "string",
        "textwrap",
        "typing",
        "unicodedata",
    }
)
_REAL_IMPORT = builtins.__import__


def _limited_import(name: str, globals=None, locals=None, fromlist=(), level: int = 0):
    if level != 0 or not isinstance(name, str) or name.split(".", 1)[0] not in _ALLOWED_IMPORTS:
        raise PermissionError("EVAL_IMPORT_DENIED")
    return _REAL_IMPORT(name, globals, locals, fromlist, level)


_DENIED_BUILTINS = {
    "breakpoint",
    "compile",
    "eval",
    "exec",
    "exit",
    "help",
    "input",
    "open",
    "quit",
}
_SAFE_BUILTINS = {name: value for name, value in vars(builtins).items() if name not in _DENIED_BUILTINS}
_SAFE_BUILTINS["__import__"] = _limited_import
_NAMESPACE: dict[str, object] = {"__name__": "__overdrive_eval__", "__builtins__": _SAFE_BUILTINS}


def _emit(value: dict) -> None:
    _WIRE.write(json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=lambda item: repr(item)))
    _WIRE.write("\n")
    _WIRE.flush()


def _bounded_repr(value: object, maximum: int) -> tuple[str, bool]:
    if value is None:
        return "", False
    try:
        rendered = repr(value)
    except BaseException as error:  # pragma: no cover - defensive user object path
        rendered = f"<repr failed: {type(error).__name__}>"
    if len(rendered) <= maximum:
        return rendered, False
    return rendered[:maximum], True


def _execute(code: str, maximum_output: int, maximum_value: int) -> dict:
    out = _BoundedText(maximum_output)
    err = _BoundedText(maximum_output)
    started = time.monotonic_ns()
    value: object = None
    try:
        tree = ast.parse(code, filename="<overdrive-python-eval>", mode="exec")
        with redirect_stdout(out), redirect_stderr(err):
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                prefix = ast.Module(body=tree.body[:-1], type_ignores=tree.type_ignores)
                if prefix.body:
                    exec(compile(prefix, "<overdrive-python-eval>", "exec"), _NAMESPACE, _NAMESPACE)
                value = eval(compile(ast.Expression(tree.body[-1].value), "<overdrive-python-eval>", "eval"), _NAMESPACE, _NAMESPACE)
            else:
                exec(compile(tree, "<overdrive-python-eval>", "exec"), _NAMESPACE, _NAMESPACE)
        rendered, value_truncated = _bounded_repr(value, maximum_value)
        return {
            "status": "PASS",
            "stdout": out.text(),
            "stderr": err.text(),
            "value": rendered,
            "outputTruncated": out.truncated or err.truncated,
            "valueTruncated": value_truncated,
            "durationMs": round((time.monotonic_ns() - started) / 1_000_000, 3),
        }
    except BaseException as error:
        message = f"{type(error).__name__}: {error}"
        if len(message) > maximum_value:
            message = message[:maximum_value]
        return {
            "status": "ERROR",
            "stdout": out.text(),
            "stderr": err.text(),
            "value": "",
            "errorType": type(error).__name__,
            "error": message,
            "outputTruncated": out.truncated or err.truncated,
            "valueTruncated": False,
            "durationMs": round((time.monotonic_ns() - started) / 1_000_000, 3),
        }


_emit({"type": "ready", "language": "python", "protocol": 1})
for _line in sys.stdin:
    try:
        _request = json.loads(_line)
        if not isinstance(_request, dict) or _request.get("op") != "execute" or not isinstance(_request.get("id"), str):
            raise ValueError("EVAL_REQUEST_INVALID")
        _code = _request.get("code")
        _max_output = _request.get("maxOutputBytes")
        _max_value = _request.get("maxValueChars")
        if not isinstance(_code, str) or not isinstance(_max_output, int) or not isinstance(_max_value, int):
            raise ValueError("EVAL_REQUEST_INVALID")
        _emit({"type": "result", "id": _request["id"], **_execute(_code, _max_output, _max_value)})
    except BaseException as _error:
        _emit({"type": "protocol_error", "error": type(_error).__name__})
