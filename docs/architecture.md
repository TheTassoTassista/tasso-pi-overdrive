# Architecture

The main Pi session is the supervisor and only persistent conversational context. It owns user interaction, approvals, the compact task notebook, and final decisions. Specialist agents receive fresh context and a bounded handoff; their outputs return to the supervisor as evidence, not authority.

```text
user ↔ Pi supervisor
          ├─ guarded local tools (read/edit/write; no free shell)
          ├─ compact discovery (FFF + AST + TypeScript semantics)
          ├─ live sources (web tools; browser when interaction is needed)
          ├─ isolated agents (scout/plan/work/test/review)
          └─ state machine → sandboxed verification → immutable evidence
```

The design deliberately uses phase-boundary model routing rather than per-prompt proxy routing. This keeps the main provider path native, preserves prompt-cache stability, avoids silent model substitution, and exposes each expensive escalation as an explicit subagent launch.

State is separated by purpose:

- Pi authentication and model catalog: existing `~/.pi/agent` files, untouched except normal Pi reads.
- Pi configuration: backed up before edits, then atomically updated.
- Package caches: Pi-owned under its agent directory.
- Worktrees: `~/.local/share/pi-overdrive/worktrees`, one managed branch/worktree per autonomous workflow.
- Browser runtime/profile: isolated upstream browser state; personal profiles are never selected by default.
- Trace data: owner-only metadata JSONL under `${XDG_STATE_HOME:-~/.local/state}/pi-overdrive/traces`.
- Durable repository knowledge: small project docs, never raw session transcripts.

The permanent package is `/home/tasso/Documents/Codex/tasso-pi-overdrive`; active Pi settings reference no dated task output. Pi project trust is a code-loading decision, not a sandbox. Bubblewrap contains autonomous commands, while the trusted Pi/extension host remains outside it. High-risk or hostile kernel-facing code still belongs in a container/VM or a low-privilege account.
