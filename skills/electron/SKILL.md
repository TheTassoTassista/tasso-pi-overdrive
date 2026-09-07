---
name: electron
description: Develop and review Electron applications across main, preload, renderer, IPC, packaging, and desktop verification. Use for Electron code or desktop web shells.
---
# Electron

Map main/preload/renderer trust boundaries and packaging configuration. Keep `contextIsolation` enabled, expose the smallest typed preload API, validate IPC arguments, and never expose unrestricted Node primitives to the renderer.

Treat navigation, external URLs, permissions, protocol handlers, updater paths, and persisted user data as security-sensitive. Keep platform differences explicit.

Verify process startup, IPC behavior, console errors, packaging checks, and a temporary-profile launch. Do not attach automation to the user's normal profile.
