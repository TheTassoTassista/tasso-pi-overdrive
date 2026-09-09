# Bubblewrap sandbox

Run a build or test with the repository as the only writable host tree:

```bash
scripts/sandbox-run.sh /absolute/repository -- npm test
```

The wrapper creates new user, PID, IPC, UTS, cgroup, and network namespaces; mounts fresh home, `/tmp`, and `/etc` trees; exposes `/usr` read-only; and binds the selected root at `/workspace`. Network is always disabled. Conventional `.env`, credential, key, SSH/GPG/keyring paths in the repository are over-mounted empty, and `.git` is read-only. Commands requiring downloads belong in a separately authorized manual workflow, not this autonomous sandbox.

The wrapper does not mount Pi authentication or the normal home directory and does not run Pi itself. The command can mutate ordinary files inside the disposable worktree, which is intentional. It is a bounded execution helper, not a substitute for a maintained container image/VM when testing hostile kernel-facing code, privileged operations, or production secrets.
