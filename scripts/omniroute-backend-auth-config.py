#!/usr/bin/env python3
"""Create and verify the protected, API-key-enforced backend env for OmniRoute."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
import sys


class ConfigError(ValueError):
    pass


LEGACY_KEYS = {
    "JWT_SECRET", "API_KEY_SECRET", "INITIAL_PASSWORD", "FORCE_OWNERSHIP",
    "REQUIRE_API_KEY", "HOSTNAME", "PORT", "BASE_URL",
    "NEXT_PUBLIC_BASE_URL", "AUTH_COOKIE_SECURE",
}
SECURE_KEYS = LEGACY_KEYS | {"OMNIROUTE_API_KEY"}
ROOT_MODE = 0o755
SECRET_MODE = 0o600


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ConfigError(reason)


def _read_root_file(root: str, name: str, mode: int = SECRET_MODE, owner: tuple[int, int] = (0, 0)) -> bytes:
    path = os.path.join(root, name)
    before = os.lstat(path)
    _require(stat.S_ISREG(before.st_mode) and not stat.S_ISLNK(before.st_mode), "file_type_invalid")
    _require((before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_nlink) == (*owner, mode, 1), "file_metadata_invalid")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(fd)
        _require((opened.st_dev, opened.st_ino, opened.st_size) == (before.st_dev, before.st_ino, before.st_size), "file_identity_changed")
        chunks = bytearray()
        while True:
            part = os.read(fd, 65536)
            if not part:
                break
            chunks.extend(part)
            _require(len(chunks) <= 1024 * 1024, "file_too_large")
        after = os.fstat(fd)
        named = os.lstat(path)
        _require((opened.st_dev, opened.st_ino, opened.st_size) == (after.st_dev, after.st_ino, after.st_size), "file_changed_while_reading")
        _require((named.st_dev, named.st_ino) == (opened.st_dev, opened.st_ino), "file_replaced_while_reading")
        return bytes(chunks)
    finally:
        os.close(fd)


def _parse_env(raw: bytes) -> dict[str, str]:
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ConfigError("env_encoding_invalid") from exc
    _require(text.endswith("\n") and "\r" not in text and "\x00" not in text, "env_format_invalid")
    rows = [line.split("=", 1) for line in text.splitlines()]
    _require(all(len(row) == 2 and row[0] for row in rows), "env_row_invalid")
    values = dict(rows)
    _require(len(values) == len(rows), "env_duplicate_key")
    return values


def _protected_root(root: str, owner: tuple[int, int] = (0, 0)) -> None:
    entry = os.lstat(root)
    _require(stat.S_ISDIR(entry.st_mode) and not stat.S_ISLNK(entry.st_mode), "root_type_invalid")
    _require((entry.st_uid, entry.st_gid, stat.S_IMODE(entry.st_mode)) == (*owner, ROOT_MODE), "root_metadata_invalid")


def _expected_secure_env(root: str, owner: tuple[int, int] = (0, 0)) -> tuple[bytes, str]:
    _protected_root(root, owner)
    base_raw = _read_root_file(root, "backend.env", owner=owner)
    proxy_raw = _read_root_file(root, "caddy.env", owner=owner)
    base = _parse_env(base_raw)
    proxy = _parse_env(proxy_raw)
    _require(set(base) == LEGACY_KEYS, "legacy_backend_schema_mismatch")
    _require(set(proxy) == {"OMNIROUTE_PROXY_TOKEN"}, "proxy_env_schema_mismatch")
    token = proxy["OMNIROUTE_PROXY_TOKEN"]
    _require(re.fullmatch(r"[A-Fa-f0-9]{64,4096}", token) is not None, "proxy_token_invalid")
    _require(re.fullmatch(r"[a-f0-9]{64}", base["JWT_SECRET"]) is not None, "jwt_secret_invalid")
    _require(re.fullmatch(r"[a-f0-9]{64}", base["API_KEY_SECRET"]) is not None, "api_key_secret_invalid")
    _require(re.fullmatch(r"[A-Za-z0-9._~!@#%+=-]{24,}", base["INITIAL_PASSWORD"]) is not None, "admin_password_invalid")
    _require(base["FORCE_OWNERSHIP"] == "false" and base["REQUIRE_API_KEY"] == "false", "legacy_backend_policy_mismatch")
    _require(base["HOSTNAME"] == "127.0.0.1" and base["PORT"] == "20128", "backend_bind_mismatch")
    _require(base["BASE_URL"] == "http://127.0.0.1:20128" and base["NEXT_PUBLIC_BASE_URL"] == "https://127.0.0.1:20129", "backend_origin_mismatch")
    _require(base["AUTH_COOKIE_SECURE"] == "true", "secure_cookie_required")
    base["REQUIRE_API_KEY"] = "true"
    base["OMNIROUTE_API_KEY"] = token
    secure_raw = "".join(f"{key}={value}\n" for key, value in base.items()).encode("ascii")
    return secure_raw, hashlib.sha256(token.encode("ascii")).hexdigest()


def prepare_auth_env(root: str, owner: tuple[int, int] = (0, 0)) -> str:
    expected, _key_digest = _expected_secure_env(root, owner)
    path = os.path.join(root, "backend-auth.env")
    try:
        existing = _read_root_file(root, "backend-auth.env", owner=owner)
    except FileNotFoundError:
        existing = None
    if existing is not None:
        _require(existing == expected, "existing_auth_env_mismatch_preserved")
        return "reused"

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, SECRET_MODE)
    except FileExistsError as exc:
        raise ConfigError("auth_env_raced_into_place_preserved") from exc
    try:
        os.fchown(fd, *owner)
        os.fchmod(fd, SECRET_MODE)
        info = os.fstat(fd)
        _require(stat.S_ISREG(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode), info.st_nlink) == (*owner, SECRET_MODE, 1), "auth_env_metadata_invalid")
        view = memoryview(expected)
        while view:
            written = os.write(fd, view)
            _require(written > 0, "auth_env_write_failed")
            view = view[written:]
        os.fsync(fd)
        after = os.fstat(fd)
        named = os.lstat(path)
        _require((after.st_dev, after.st_ino, after.st_size) == (info.st_dev, info.st_ino, len(expected)), "auth_env_identity_changed")
        _require((named.st_dev, named.st_ino) == (info.st_dev, info.st_ino), "auth_env_replaced_during_write")
    finally:
        os.close(fd)
    dir_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    return "created"


def verify_auth_env(root: str, owner: tuple[int, int] = (0, 0)) -> str:
    expected, key_digest = _expected_secure_env(root, owner)
    actual = _read_root_file(root, "backend-auth.env", owner=owner)
    _require(actual == expected, "auth_env_integrity_mismatch")
    return key_digest


def configured_key_digest(root: str, owner: tuple[int, int] = (0, 0)) -> str:
    _protected_root(root, owner)
    backend = _parse_env(_read_root_file(root, "backend.env", owner=owner))
    proxy = _parse_env(_read_root_file(root, "caddy.env", owner=owner))
    token = proxy.get("OMNIROUTE_PROXY_TOKEN", "")
    _require(re.fullmatch(r"[A-Fa-f0-9]{64,4096}", token) is not None, "proxy_token_invalid")
    if "OMNIROUTE_API_KEY" in backend:
        _require(backend.get("REQUIRE_API_KEY") == "true" and backend["OMNIROUTE_API_KEY"] == token, "secure_backend_auth_mismatch")
        _require("backend-auth.env" not in os.listdir(root), "unexpected_legacy_auth_env")
        return hashlib.sha256(token.encode("ascii")).hexdigest()
    return verify_auth_env(root, owner)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--root", required=True)
    digest = sub.add_parser("key-digest")
    digest.add_argument("--root", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "prepare":
            result = prepare_auth_env(args.root)
            verify_auth_env(args.root)
            print(f"OMNIROUTE_BACKEND_AUTH_CONFIG=PASS state={result}")
            return 0
        print(configured_key_digest(args.root))
        return 0
    except (ConfigError, OSError):
        print("OMNIROUTE_BACKEND_AUTH_CONFIG=FAIL_CLOSED", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
