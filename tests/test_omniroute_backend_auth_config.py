import importlib.util
import os
import stat
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


if __name__ == "__main__":
    unittest.main()
