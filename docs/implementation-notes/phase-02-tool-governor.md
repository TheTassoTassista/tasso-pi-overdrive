# Phase 2 implementation note — Tool Governor

## Reference inspection

This phase rechecked OMP's pinned `ToolLoadMode` contract and representative discoverable LSP, web-search, security-scan, and task tools at commit `4267074ac91456866e95ed8de0b6353388f08502`. The useful architectural lesson is the separation between capability availability and permanent top-level schema visibility. No OMP source was copied, and OMP executable measurements remain `NOT_RUN` because Bun >=1.4 is unavailable.

## Smallest coherent design

The Tool Governor is a deterministic controller layered on the Phase 1 Task Policy and Pi's supported `getAllTools`/`setActiveTools` lifecycle. It defines four visibility classes:

- always-essential: the bounded workspace reader;
- conditional: preferred FFF/AST search, edit, structural AST rewrite, semantic navigation, memory, verification, and the enforced workflow entry point when the task actually needs them;
- high-risk conditional: browser and web tools, exposed only when Task Policy explicitly identifies that capability;
- hidden/on-demand: sandboxed execution and the MCP proxy, discoverable through `/tools` but absent from automatic schemas.

Raw shell, raw subagent, and file removal remain controller-only and cannot be activated by `/tools`. Unknown tools also fail closed. A versioned, digest-bound Tool Policy records only capability/tool names, counts, and the parent Task Policy digest; it stores no prompt or task text.

Structural mutation has its own `structural-edit` capability. It requires a mutation action, a syntactic target such as call expressions/import declarations/syntax nodes, and either structural wording or an explicit multi-match scope. Merely naming `ast_grep_rewrite`, or asking for a simple text/string replacement, cannot activate it. Search-only tasks prefer FFF over duplicate built-in grep/find schemas, expose AST search only for code tasks, and never receive edit/write/rewrite.

`before_agent_start` resolves the policy against the live Pi tool registry immediately before the turn and updates the active schema set. Explicit CLI tool-selection flags remain authoritative and disable automatic changes. A deliberate session-local `/tools enable|disable|auto` choice is also preserved across turns. On an automatic policy failure, only `read` remains active when available.

The Second Brain independently consults the same deterministic Task Policy before retrieval, so a small direct edit does not pay memory routing/backend overhead before the later tool-surface hook runs.

## Compatibility boundary

No tool implementation, model/provider route, fan-out, retry rule, workflow limit, authentication setting, or package dependency changes in this phase. The existing startup compact core remains as the pre-prompt surface; dynamic narrowing occurs per turn. Pi 0.85.1 has no native extended/discoverable namespace equivalent, so `/tools` is the schema-free discovery/control plane.

## Evidence

- 12 Task Governor and 11 Tool Governor tests cover semantic structural gating, superficial-name denial, search-only non-mutation, required capability visibility, hidden/high-risk denial, explicit CLI precedence, manual mode, missing capability reporting, metadata privacy, and semantic/digest tamper rejection.
- Eight real Pi 0.85.1 turns through a deterministic local provider report the exact schema set seen by the model. A simple edit sees 4 tools/2,799 schema characters instead of the starting 7/4,171; search-only sees 6/3,012; structural edit sees `ast_grep_rewrite`; browser sees 2/1,148. `/tools` is registered by Pi as an extension command.
- The benchmark made zero network/external-provider/paid calls and cost zero. OMP remains honestly `NOT_RUN`.
- Full project validation is 239/239 tests PASS plus syntax, memory syntax, installed-Pi TypeScript, and package validation PASS with the verified managed LSP runtime.
