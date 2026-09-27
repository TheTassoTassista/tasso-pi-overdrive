# B1 clean-clone primary/cleanup contract — COMPLETE

Functional fbb6069bf012a5e7b55e009503bdfc88b7305451, real CI36305193845.
See phi-clean-clone-cleanup-evidence.json for exact metadata-only proof.

scripts/phi-clean-room.mjs records every completed command and separates primary
from cleanup via lib/phi-clone-cleanup.mjs. PASS requires both; timeout/nonzero
cannot become PASS because cleanup succeeds. Unknown ownership retains the root
and reports FAIL separately, without erasing earlier receipts.

platform/windows/validation-process.mjs and native/OwnedProcess.cs are private
INTERNAL_TRUSTED validation infrastructure, NOT an agent sandbox/tool. Actual
Windows validation targets use suspended Job assignment, generation-bound
guardian, kill-on-close, verified empty Job and drained pipes. Command output is
internal base64 transport, never a published receipt. Agent/tool target execution
still uses the LPAC broker, not this trusted endpoint.

Only the exact code-owned Node scripts/phi-check.mjs --owned-validation command
receives the aggregate600s ceiling and serial test-file scheduling. All other
validation/recovery and ordinary/LPAC commands retain120s;32process/5scleanup
limits unchanged. The prior global stage selector leaked600s into scope status,
which native correctly rejected before launch. Exact command matching and a
regression fix that defect; no security check was relaxed.

Cleanup accepts only an identified fresh immediate system-temp child with the
fixed harness prefix. It rejects broad paths, reparse/symlink roots, identity
changes and unproved native ownership. It moves controller CWD out first and
never globally kills PIDs. Only transient Windows EBUSY/EPERM/ENOTEMPTY retries:
6attempts,25/50/100/200/400ms backoff (775ms),2s retry-admission ceiling. This is
not a hard deadline for an individual blocking OS filesystem syscall. Permanent
failure retains data as RETAINED_ON_FAILURE, not a physical quarantine move.

Native fixtures hold actual READ_DATA/LIST_DIRECTORY handles without DELETE
sharing, require actual DeleteFile/RemoveDirectory denial32 before READY, then
prove release/removal. Attribute-only handles did not deny deletion and are not
counted as proof. CWD, inherited-child handle, timeout and exited-parent/remaining
descendant controls also run on Windows; no mock denial or required native skip.

Residual0 covers recorded owned validation Jobs only, not unrelated host processes.
Linux cleanup does not assert native Job ownership. Original51460 timeout/lock
owner remain UNKNOWN; new readable failure and native controls do not prove its
historical cause. Auth/ignored runtime absent in clones; full Pi reconstruction,
Worker, LSP, publication and Windows autonomy remain uncertified.
