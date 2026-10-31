import importlib.util
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "omniroute_backend_auth_config", ROOT / "scripts" / "omniroute-backend-auth-config.py"
)
AUTH_CONFIG = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(AUTH_CONFIG)


class BackendAuthConfigTests(unittest.TestCase):
    owner = (os.geteuid(), os.getegid())

    def make_root(self):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        os.chmod(root, 0o755)
        proxy = "a" * 64
        (root / "caddy.env").write_text(f"OMNIROUTE_PROXY_TOKEN={proxy}\n", encoding="ascii")
        backend = {
            "JWT_SECRET": "b" * 64,
            "API_KEY_SECRET": "c" * 64,
            "INITIAL_PASSWORD": "D" * 32,
            "FORCE_OWNERSHIP": "false",
            "REQUIRE_API_KEY": "false",
            "HOSTNAME": "127.0.0.1",
            "PORT": "20128",
            "BASE_URL": "http://127.0.0.1:20128",
            "NEXT_PUBLIC_BASE_URL": "https://127.0.0.1:20129",
            "AUTH_COOKIE_SECURE": "true",
        }
        (root / "backend.env").write_text("".join(f"{key}={value}\n" for key, value in backend.items()), encoding="ascii")
        for path in (root / "caddy.env", root / "backend.env"):
            os.chmod(path, 0o600)
        return temporary, root, proxy, backend

    def test_upgrade_creates_root_private_enforced_env_from_proxy_key(self):
        temporary, root, proxy, backend = self.make_root()
        with temporary:
            self.assertEqual(AUTH_CONFIG.prepare_auth_env(str(root), self.owner), "created")
            auth_path = root / "backend-auth.env"
            auth_stat = auth_path.stat()
            self.assertEqual((auth_stat.st_uid, auth_stat.st_gid, stat.S_IMODE(auth_stat.st_mode)), (*self.owner, 0o600))
            auth = AUTH_CONFIG._parse_env(auth_path.read_bytes())
            self.assertEqual(auth["REQUIRE_API_KEY"], "true")
            self.assertEqual(auth["OMNIROUTE_API_KEY"], proxy)
            self.assertEqual({key: auth[key] for key in backend}, {**backend, "REQUIRE_API_KEY": "true"})
            self.assertEqual(AUTH_CONFIG.verify_auth_env(str(root), self.owner), __import__("hashlib").sha256(proxy.encode()).hexdigest())
            self.assertEqual(AUTH_CONFIG.prepare_auth_env(str(root), self.owner), "reused")

    def test_existing_mismatched_auth_env_is_preserved_and_rejected(self):
        temporary, root, _, _ = self.make_root()
        with temporary:
            path = root / "backend-auth.env"
            path.write_text("untrusted=do-not-overwrite\n", encoding="ascii")
            os.chmod(path, 0o600)
            original = path.read_bytes()
            with self.assertRaisesRegex(AUTH_CONFIG.ConfigError, "existing_auth_env_mismatch_preserved"):
                AUTH_CONFIG.prepare_auth_env(str(root), self.owner)
            self.assertEqual(path.read_bytes(), original)

    def test_missing_or_wrong_key_auth_env_cannot_be_used_for_backend_resume(self):
        temporary, root, proxy, _ = self.make_root()
        with temporary:
            AUTH_CONFIG.prepare_auth_env(str(root), self.owner)
            sidecar = root / "backend-auth.env"
            valid = sidecar.read_bytes()
            with self.assertRaises(OSError):
                sidecar.unlink()
                AUTH_CONFIG.configured_key_digest(str(root), self.owner)

            sidecar.write_bytes(valid.replace(proxy.encode(), ("e" * 64).encode()))
            os.chmod(sidecar, 0o600)
            with self.assertRaisesRegex(AUTH_CONFIG.ConfigError, "auth_env_integrity_mismatch"):
                AUTH_CONFIG.configured_key_digest(str(root), self.owner)

    def test_symlink_and_legacy_policy_mismatch_fail_closed(self):
        temporary, root, _, _ = self.make_root()
        with temporary:
            caddy = root / "caddy.env"
            caddy.unlink()
            caddy.symlink_to(root / "missing")
            with self.assertRaises(AUTH_CONFIG.ConfigError):
                AUTH_CONFIG.prepare_auth_env(str(root), self.owner)
        temporary, root, _, backend = self.make_root()
        with temporary:
            backend["REQUIRE_API_KEY"] = "true"
            (root / "backend.env").write_text("".join(f"{key}={value}\n" for key, value in backend.items()), encoding="ascii")
            os.chmod(root / "backend.env", 0o600)
            with self.assertRaisesRegex(AUTH_CONFIG.ConfigError, "legacy_backend_policy_mismatch"):
                AUTH_CONFIG.prepare_auth_env(str(root), self.owner)

    def test_only_digest_of_key_is_available_for_attestation(self):
        temporary, root, proxy, backend = self.make_root()
        with temporary:
            AUTH_CONFIG.prepare_auth_env(str(root), self.owner)
            digest = AUTH_CONFIG.configured_key_digest(str(root), self.owner)
            self.assertEqual(len(digest), 64)
            self.assertNotIn(proxy, digest)
            (root / "backend-auth.env").unlink()
            secure = dict(backend, REQUIRE_API_KEY="true", OMNIROUTE_API_KEY=proxy)
            (root / "backend.env").write_text("".join(f"{key}={value}\n" for key, value in secure.items()), encoding="ascii")
            os.chmod(root / "backend.env", 0o600)
            self.assertEqual(AUTH_CONFIG.configured_key_digest(str(root), self.owner), digest)

    def test_candidate_config_receipt_uses_effective_sidecar_auth_mode(self):
        """Execute the candidate's actual embedded config validator on local fixtures."""
        source = (ROOT / "scripts" / "omniroute-docker-candidate.sh").read_text(encoding="utf-8")
        match = re.search(
            r'existing_config_receipt=\$\(python3 - "\$ROOT" <<\'PY\'\n(.*?)\nPY\n\s*\) \|\| fail',
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "candidate must retain its embedded fail-closed config verifier")
        validator = match.group(1)
        # The production verifier requires root ownership. The test runs the
        # identical verifier logic with only the expected fixture owner adapted
        # to this unprivileged test process; file types, modes, link counts,
        # schemas, values, and all control flow remain unchanged.
        validator, root_replacements = re.subn(
            r"\(root_stat\.st_uid, root_stat\.st_gid, stat\.S_IMODE\(root_stat\.st_mode\)\) != \(0, 0, 0o755\)",
            "(root_stat.st_uid, root_stat.st_gid, stat.S_IMODE(root_stat.st_mode)) != (os.geteuid(), os.getegid(), 0o755)",
            validator,
        )
        validator, file_replacements = re.subn(
            r"\(before\.st_uid, before\.st_gid, stat\.S_IMODE\(before\.st_mode\), before\.st_nlink\) != \(0, 0, mode, 1\)",
            "(before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_nlink) != (os.geteuid(), os.getegid(), mode, 1)",
            validator,
        )
        self.assertEqual((root_replacements, file_replacements), (1, 1))

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            os.chmod(root, 0o755)
            token = "a" * 64
            legacy = {
                "JWT_SECRET": "b" * 64,
                "API_KEY_SECRET": "c" * 64,
                "INITIAL_PASSWORD": "D" * 32,
                "FORCE_OWNERSHIP": "false",
                "REQUIRE_API_KEY": "false",
                "HOSTNAME": "127.0.0.1",
                "PORT": "20128",
                "BASE_URL": "http://127.0.0.1:20128",
                "NEXT_PUBLIC_BASE_URL": "https://127.0.0.1:20129",
                "AUTH_COOKIE_SECURE": "true",
            }
            files = {
                "Caddyfile": b"candidate fixture\n",
                "backend.env": "".join(f"{key}={value}\n" for key, value in legacy.items()).encode(),
                "ca.crt": b"fixture certificate\n",
                "caddy.env": f"OMNIROUTE_PROXY_TOKEN={token}\n".encode(),
                "tls.key": b"fixture private key\n",
            }

            def run_validator():
                return subprocess.run(
                    [sys.executable, "-c", validator, str(root)],
                    capture_output=True,
                    text=True,
                    check=False,
                    env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                )

            for name, raw in files.items():
                (root / name).write_bytes(raw)
                os.chmod(root / name, 0o600 if name in {"backend.env", "caddy.env", "tls.key"} else 0o644)

            legacy_receipt = run_validator()
            self.assertEqual(legacy_receipt.returncode, 0, legacy_receipt.stderr)
            self.assertEqual(legacy_receipt.stdout.strip(), "OMNIROUTE_CANDIDATE=EXISTING_CONFIG_CHECK=PASS auth_mode=legacy")

            enforced = dict(legacy, REQUIRE_API_KEY="true", OMNIROUTE_API_KEY=token)
            sidecar = root / "backend-auth.env"
            sidecar.write_text("".join(f"{key}={value}\n" for key, value in enforced.items()), encoding="ascii")
            os.chmod(sidecar, 0o600)
            receipt = run_validator()
            self.assertEqual(receipt.returncode, 0, receipt.stderr)
            self.assertEqual(receipt.stdout.strip(), "OMNIROUTE_CANDIDATE=EXISTING_CONFIG_CHECK=PASS auth_mode=enforced")
            self.assertNotIn(token, receipt.stdout + receipt.stderr)

            sidecar.write_text(sidecar.read_text(encoding="ascii").replace(token, "d" * 64), encoding="ascii")
            os.chmod(sidecar, 0o600)
            altered = run_validator()
            self.assertNotEqual(altered.returncode, 0)
            self.assertEqual(altered.stderr.strip(), "OMNIROUTE_CANDIDATE=EXISTING_CONFIG_CHECK=FAIL_CLOSED")
            self.assertNotIn(token, altered.stdout + altered.stderr)
            self.assertNotIn("d" * 64, altered.stdout + altered.stderr)


if __name__ == "__main__":
    unittest.main()
