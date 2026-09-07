# Bubblewrap sandbox

Run a build or test with the repository as the only writable host tree:

```bash
scripts/sandbox-run.sh /absolute/repository -- npm test
```

The wrapper creates new user, PID, IPC, UTS, cgroup, and network namespaces; mounts a fresh home and `/tmp`; exposes system binaries/config read-only; and binds the selected root at `/workspace`. The default has no network. For an explicitly approved dependency download or network test:

```bash
scripts/sandbox-run.sh --network /absolute/repository -- npm test
```

The wrapper does not mount Pi authentication or the normal home directory and does not run Pi itself. It is a bounded execution helper, not a substitute for a maintained container image/VM when testing hostile kernel-facing code, privileged operations, or production secrets.
