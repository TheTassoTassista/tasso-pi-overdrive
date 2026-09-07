---
description: Threat-model and review a security-sensitive change
argument-hint: "<surface or change>"
---
Security scope: ${@:-current changes}.

Map assets, actors, entry points, trust boundaries, and privileged effects. Trace untrusted input to sinks. Check authentication, authorization, injection, secrets, path traversal, SSRF, unsafe deserialization, dependency changes, logging leakage, and failure defaults as applicable. Use authoritative current references when needed. Provide evidence-backed findings, mitigations, and verification without reading secret files.
