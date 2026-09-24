# Phase 33 — General-purpose browser: deferred for safety

The existing autonomous browser remains `LOCAL_ISOLATED`: it accepts only the controller's exact reserved loopback URL, assigned fresh session/private profile, and a small DOM/screenshot command set. Chromium and the runner share one pinned, networkless Bubblewrap namespace (`--unshare-all`), and the controller checks namespace/process identity before returning results. Downloads, arbitrary navigation, auth/cookie/storage modes, profile import, uploads, attach, and JavaScript eval are denied before runner startup. The current real-Pi/Chromium benchmark proves the local fixture and host-network sentinel boundary, not external browsing.

The Phase 33 target modes are distinct authorities:

| Mode | Current status | Required boundary |
|---|---|---|
| `LOCAL_ISOLATED` | IMPLEMENTED / REAL-HOST-VERIFIED | Existing reserved loopback fixture and networkless namespace; remains the autonomous default. |
| `PUBLIC_WEB` | UNAVAILABLE | Explicit task/policy opt-in, controller-owned egress enforcement (including redirects, subresources, DNS and private-address denial), destination evidence, downloads off by default, and a real host/network sentinel smoke. A model-supplied URL allowlist is insufficient. |
| `AUTHENTICATED_SITE` | UNAVAILABLE | Separate explicit user authorization and managed profile, reviewed credential import/login, per-origin egress, cookie/storage lifecycle, redaction, retention and model/trace disclosure controls. Never inherit a personal Chrome profile. |

The current browser's `--allowed-domains` feasibility probe already failed with profile mode and a port-qualified allowlist; no controller/network-layer outbound allowlist exists. Merely removing `--unshare-all` would abandon the demonstrated security boundary. Therefore Phase 33 does **not** enable `PUBLIC_WEB`, authenticated browsing, downloads, or PDF/network features. No dead `browserMode` field is added to the model schema that might look like working authority. Existing public web fetch/research tools remain separate from browser automation.

Disposition: **DEFERRED FOR SAFETY** pending a concrete network broker and explicit authenticated-session authority. This is an intentional bounded result, not a general-browser PASS. No paid/external provider calls, credential changes, or code/config mutations were needed for this assessment.
