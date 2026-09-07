# MCP policy

MCP is disabled in this installation because the current vetted adapter (`pi-mcp-adapter@2.32.1`) declares `@earendil-works/pi-ai ^0.84.1`, which excludes Pi 0.85.1. Installing it anyway would violate the compatibility rule.

When a compatible release exists, audit its manifest, lifecycle scripts, config discovery, authentication storage, server launch paths, approval behavior, and output spill policy. Start from `config/mcp.example.json`: empty server set, proxy tools, lazy lifecycle, no ambient host-config discovery, approval for every MCP call, bounded output, sampling off, and metadata-only tracing.

Add one server at a time. Pin local commands and remote URLs, keep credentials in environment/OS credential storage, run a read-only tool first, inspect the registered tool count, and promote only a small stable allowlist to direct tools. Keep broad servers behind proxy discovery to protect prompt-cache stability.
