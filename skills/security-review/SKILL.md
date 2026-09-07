---
name: security-review
description: Perform adversarial code security review and threat modeling. Use when changes touch authentication, authorization, secrets, untrusted input, network access, commands, files, or sensitive data.
---
# Security Review

Identify assets, actors, entry points, trust boundaries, privileged effects, and failure defaults. Trace untrusted input to sensitive sinks.

Check authorization independently of authentication; injection across shell/SQL/template/path/URL boundaries; secret lifecycle and logging; SSRF; traversal; races; unsafe deserialization; dependency provenance; and denial-of-service limits as applicable.

Do not access live secrets. Demonstrate issues with safe fixtures. Rank findings by exploitability and impact, cite exact evidence, and propose the smallest effective mitigation plus a regression check.
