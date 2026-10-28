# Phi execution priorities

## FAST DEFAULT

- Optimize for the shortest safe path to a working result; avoid regressions and unnecessary ceremony.
- Implement authorized, bounded changes before writing reports. Do not stop for intermediate confirmation on ordinary local changes already within scope.
- Reuse current repository state, existing subsystems, and still-valid evidence. Validate changed inputs once; repeat a check only when new evidence or a relevant change justifies it.
- Prefer a minimal extension of an existing path over new architecture, services, managers, agents, or dependencies.
- Complete a coherent work unit and update `harness/CONTINUATION.md` and the relevant progress ledger.
- FAST DEFAULT never overrides security boundaries, explicit approval requirements, protected data, host-operation limits, or fail-closed behavior. Never bypass a gate just to reduce elapsed time.
