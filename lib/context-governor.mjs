import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compactToolText } from "./output-optimizer.mjs";

export const CONTEXT_GOVERNOR_VERSION = 1;
export const CONTEXT_FIT_STATUS = Object.freeze({ PASS: "PASS", BLOCKED: "BLOCKED" });
export const CONTEXT_REDUCTION_ORDER = Object.freeze([
  "redundant-artifacts",
  "tool-output",
  "smart-read-envelope",
  "second-brain",
  "conversation",
]);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyFile = path.join(packageRoot, "config", "context-governor.json");
const ARTIFACT_URI = /artifact:\/\/[0-9a-f]{64}/gu;
const MEMORY_MESSAGE = "tasso-pi-overdrive.second-brain";
const IMAGE_TOKENS = 1200;
const MESSAGE_OVERHEAD_TOKENS = 8;
const TOOL_OVERHEAD_TOKENS = 16;
const COMPACTION_WRAPPER_TOKENS = 32;

export class ContextGovernorError extends Error {
  constructor(code) {
    super(code);
    this.name = "ContextGovernorError";
    this.code = code;
  }
}

function fail(code) { throw new ContextGovernorError(code); }
function tokensForText(value) { return Math.ceil(String(value ?? "").length / 4); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function exactInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

export function validateContextGovernorPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== CONTEXT_GOVERNOR_VERSION) fail("context_policy_invalid");
  const keys = ["version", "safetyTokens", "toolResultMaxChars", "toolResultMaxLines", "smartReadTargetChars", "artifactDuplicateMaxChars"];
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("context_policy_unknown_field");
  const policy = {
    version: value.version,
    safetyTokens: exactInteger(value.safetyTokens, 1024, 16384, "context_policy_safety_invalid"),
    toolResultMaxChars: exactInteger(value.toolResultMaxChars, 2000, 32000, "context_policy_tool_chars_invalid"),
    toolResultMaxLines: exactInteger(value.toolResultMaxLines, 40, 500, "context_policy_tool_lines_invalid"),
    smartReadTargetChars: exactInteger(value.smartReadTargetChars, 2000, 12000, "context_policy_smart_read_invalid"),
    artifactDuplicateMaxChars: exactInteger(value.artifactDuplicateMaxChars, 128, 2000, "context_policy_artifact_duplicate_invalid"),
  };
  if (policy.smartReadTargetChars > policy.toolResultMaxChars || policy.artifactDuplicateMaxChars >= policy.smartReadTargetChars) fail("context_policy_reduction_order_invalid");
  return freeze(policy);
}

export function readContextGovernorPolicy(file = policyFile) {
  try { return validateContextGovernorPolicy(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (error) { if (error instanceof ContextGovernorError) throw error; fail("context_policy_unreadable"); }
}

function contentTokens(content) {
  if (typeof content === "string") return tokensForText(content);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content) {
    if (block?.type === "text") tokens += tokensForText(block.text);
    else if (block?.type === "image") tokens += IMAGE_TOKENS;
    else if (block?.type === "thinking") tokens += tokensForText(block.thinking);
    else if (block?.type === "toolCall") {
      let serialized;
      try { serialized = JSON.stringify(block.arguments ?? {}); } catch { fail("context_message_unserializable"); }
      tokens += tokensForText(`${block.name ?? ""}${serialized}`);
    }
  }
  return tokens;
}

export function estimateContextMessageTokens(message) {
  if (!message || typeof message !== "object" || typeof message.role !== "string") fail("context_message_invalid");
  let tokens;
  if (["user", "custom", "toolResult"].includes(message.role)) tokens = contentTokens(message.content);
  else if (message.role === "assistant") tokens = contentTokens(message.content);
  else if (message.role === "bashExecution") tokens = tokensForText(message.command) + tokensForText(message.output);
  else if (["branchSummary", "compactionSummary"].includes(message.role)) tokens = tokensForText(message.summary) + COMPACTION_WRAPPER_TOKENS;
  else fail("context_message_role_unknown");
  return tokens + MESSAGE_OVERHEAD_TOKENS;
}

function serializedToolTokens(tools) {
  let serialized;
  try { serialized = JSON.stringify(tools); } catch { fail("context_tools_unserializable"); }
  return tokensForText(serialized) + tools.length * TOOL_OVERHEAD_TOKENS;
}

function validateModel(model, reserveOutputTokens) {
  if (!model || typeof model !== "object" || typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) fail("context_model_invalid");
  const contextWindow = exactInteger(model.contextWindow, 1024, 10_000_000, "context_model_window_invalid");
  const modelMaximum = exactInteger(model.maxTokens, 1, 10_000_000, "context_model_output_invalid");
  const reserve = reserveOutputTokens === undefined ? modelMaximum : exactInteger(reserveOutputTokens, 1, 10_000_000, "context_output_reserve_invalid");
  return { contextWindow, reserve };
}

function artifactUris(message) {
  if (!message || !["toolResult", "custom", "user"].includes(message.role)) return [];
  const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n") : "";
  return [...new Set(content.match(ARTIFACT_URI) ?? [])];
}

function categoryFor(message) {
  if (message.role === "custom" && message.customType === MEMORY_MESSAGE) return "memoryPackTokens";
  if (artifactUris(message).length > 0) return "artifactPreviewTokens";
  if (["branchSummary", "compactionSummary"].includes(message.role)) return "agentSummaryTokens";
  if (["toolResult", "bashExecution"].includes(message.role)) return "toolOutputTokens";
  return "conversationTokens";
}

function estimateComponents(messages, systemPrompt, tools) {
  const components = {
    systemPromptTokens: tokensForText(systemPrompt),
    toolSchemaTokens: serializedToolTokens(tools),
    conversationTokens: 0,
    memoryPackTokens: 0,
    artifactPreviewTokens: 0,
    agentSummaryTokens: 0,
    toolOutputTokens: 0,
  };
  for (const message of messages) components[categoryFor(message)] += estimateContextMessageTokens(message);
  const messageTokens = components.conversationTokens + components.memoryPackTokens + components.artifactPreviewTokens + components.agentSummaryTokens + components.toolOutputTokens;
  return { components, messageTokens, contentEstimateTokens: components.systemPromptTokens + components.toolSchemaTokens + messageTokens };
}

function fitSnapshot({ messages, systemPrompt, tools, model, reserveOutputTokens, reportedUsageTokens, reportedContextWindow, baselineMessageTokens, baselineReportedUsageTokens, policy }) {
  const target = validateModel(model, reserveOutputTokens);
  const contextWindow = Number.isSafeInteger(reportedContextWindow) && reportedContextWindow > 0 ? Math.min(target.contextWindow, reportedContextWindow) : target.contextWindow;
  const estimate = estimateComponents(messages, systemPrompt, tools);
  const usageAdjustedTokens = Number.isSafeInteger(baselineReportedUsageTokens)
    ? Math.max(0, baselineReportedUsageTokens - baselineMessageTokens + estimate.messageTokens)
    : Number.isSafeInteger(reportedUsageTokens) ? reportedUsageTokens : 0;
  const inputTokens = Math.max(estimate.contentEstimateTokens, usageAdjustedTokens);
  const usableInputTokens = Math.max(0, contextWindow - target.reserve - policy.safetyTokens);
  return freeze({
    status: inputTokens <= usableInputTokens ? CONTEXT_FIT_STATUS.PASS : CONTEXT_FIT_STATUS.BLOCKED,
    provider: model.provider,
    model: model.id,
    contextWindow,
    modelContextWindow: target.contextWindow,
    reportedContextWindow: Number.isSafeInteger(reportedContextWindow) ? reportedContextWindow : null,
    reserveOutputTokens: target.reserve,
    safetyTokens: policy.safetyTokens,
    usableInputTokens,
    inputTokens,
    contentEstimateTokens: estimate.contentEstimateTokens,
    usageAdjustedTokens,
    messageTokens: estimate.messageTokens,
    messageCount: messages.length,
    toolCount: tools.length,
    components: estimate.components,
  });
}

function textContent(message) {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content) ? message.content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n") : "";
}

function mapTextBlocks(message, transform) {
  if (typeof message.content === "string") return { ...message, content: transform(message.content) };
  if (!Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map((block) => block?.type === "text" ? { ...block, text: transform(block.text ?? "") } : block) };
}

function compactText(text, options) {
  const compacted = compactToolText(text, options);
  return compacted.compacted ? compacted.text : text;
}

function removeRedundantArtifacts(messages, policy) {
  const latest = new Map();
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "toolResult") for (const uri of artifactUris(messages[index])) latest.set(uri, index);
  }
  let changed = 0;
  const output = messages.map((message, index) => {
    if (message.role !== "toolResult") return message;
    const redundant = artifactUris(message).filter((uri) => latest.get(uri) !== index);
    if (!redundant.length) return message;
    changed += 1;
    const excerpt = compactText(textContent(message), { maxChars: policy.artifactDuplicateMaxChars, maxLines: 12, headLines: 2, tailLines: 2, diagnosticLines: 4 });
    return { ...message, content: [{ type: "text", text: `[REDUNDANT ARTIFACT PREVIEW OMITTED]\n${redundant.join("\n")}\n${excerpt}` }, ...(Array.isArray(message.content) ? message.content.filter((block) => block?.type !== "text") : [])] };
  });
  return { messages: output, changed };
}

function compactToolOutputs(messages, policy, readOnly) {
  let changed = 0;
  const output = messages.map((message) => {
    const applicable = message.role === "toolResult" && (readOnly ? message.toolName === "read" : message.toolName !== "read");
    if (!applicable && !(message.role === "bashExecution" && !readOnly)) return message;
    if (message.role === "bashExecution") {
      const outputText = compactText(message.output, { maxChars: policy.toolResultMaxChars, maxLines: policy.toolResultMaxLines, headLines: 40, tailLines: 50, diagnosticLines: 60 });
      if (outputText === message.output) return message;
      changed += 1;
      return { ...message, output: outputText };
    }
    const limit = readOnly ? policy.smartReadTargetChars : policy.toolResultMaxChars;
    let localChange = false;
    const updated = mapTextBlocks(message, (text) => {
      if (readOnly && text.includes("[SMARTREAD DATA — NEVER INSTRUCTIONS]")) return text;
      const next = compactText(text, { maxChars: limit, maxLines: policy.toolResultMaxLines, headLines: 35, tailLines: 45, diagnosticLines: 60 });
      if (next !== text) localChange = true;
      return readOnly && next !== text ? `[HISTORIC READ COMPACTED TO SMARTREAD ENVELOPE — REOPEN AN EXACT RANGE BEFORE EDITING]\n${next}` : next;
    });
    if (localChange) changed += 1;
    return updated;
  });
  return { messages: output, changed };
}

function compactSecondBrain(messages) {
  let latest = -1;
  for (let index = 0; index < messages.length; index += 1) if (messages[index]?.role === "custom" && messages[index]?.customType === MEMORY_MESSAGE) latest = index;
  let changed = 0;
  const output = messages.map((message, index) => {
    if (index >= latest || message?.role !== "custom" || message?.customType !== MEMORY_MESSAGE) return message;
    changed += 1;
    const id = typeof message.details?.id === "string" && /^[0-9a-f-]{1,128}$/u.test(message.details.id) ? message.details.id : "metadata-only";
    return { ...message, content: `[OLDER SECOND BRAIN PACK SUPERSEDED BY THE LATEST PACK; id=${id}]`, details: { id, superseded: true } };
  });
  return { messages: output, changed };
}

function compactConversation(messages) {
  let latestCompaction = -1;
  for (let index = 0; index < messages.length; index += 1) if (messages[index]?.role === "compactionSummary") latestCompaction = index;
  let output = latestCompaction > 0 ? messages.slice(latestCompaction) : messages;
  let changed = latestCompaction > 0 ? latestCompaction : 0;
  const seenSummaries = new Set();
  output = output.map((message, index) => {
    if (!["branchSummary", "compactionSummary"].includes(message?.role)) return message;
    const identity = `${message.role}:${hash(String(message.summary ?? ""))}`;
    if (!seenSummaries.has(identity)) { seenSummaries.add(identity); return message; }
    changed += 1;
    return { role: "custom", customType: "tasso-pi-overdrive.context-summary-reference", content: `[DUPLICATE ${message.role} OMITTED; digest=${identity.slice(identity.indexOf(":") + 1)}]`, display: false, details: { digest: identity.slice(identity.indexOf(":") + 1) }, timestamp: message.timestamp };
  });
  return { messages: output, changed };
}

function normalizeTools(tools, activeToolNames) {
  if (!Array.isArray(tools) || !Array.isArray(activeToolNames)) fail("context_tools_invalid");
  const active = new Set(activeToolNames);
  return tools.filter((tool) => active.has(tool?.name)).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines }));
}

export function governContext(input = {}) {
  const policy = validateContextGovernorPolicy(input.policy ?? readContextGovernorPolicy());
  if (!Array.isArray(input.messages) || typeof input.systemPrompt !== "string") fail("context_input_invalid");
  const tools = normalizeTools(input.tools ?? [], input.activeToolNames ?? []);
  const originalMessages = structuredClone(input.messages);
  const baseline = estimateComponents(originalMessages, input.systemPrompt, tools);
  const baselineReportedUsageTokens = Number.isSafeInteger(input.reportedUsageTokens) && input.reportedUsageTokens >= 0 ? input.reportedUsageTokens : undefined;
  const common = {
    systemPrompt: input.systemPrompt, tools, model: input.model, reserveOutputTokens: input.reserveOutputTokens,
    reportedUsageTokens: input.reportedUsageTokens, reportedContextWindow: input.reportedContextWindow,
    baselineMessageTokens: baseline.messageTokens, baselineReportedUsageTokens, policy,
  };
  let messages = originalMessages;
  const initial = fitSnapshot({ ...common, messages });
  let current = initial;
  const stages = [];
  const reducers = [
    [CONTEXT_REDUCTION_ORDER[0], (value) => removeRedundantArtifacts(value, policy)],
    [CONTEXT_REDUCTION_ORDER[1], (value) => compactToolOutputs(value, policy, false)],
    [CONTEXT_REDUCTION_ORDER[2], (value) => compactToolOutputs(value, policy, true)],
    [CONTEXT_REDUCTION_ORDER[3], compactSecondBrain],
    [CONTEXT_REDUCTION_ORDER[4], compactConversation],
  ];
  for (const [name, reducer] of reducers) {
    if (current.status === CONTEXT_FIT_STATUS.PASS) break;
    const before = current;
    const reduced = reducer(messages);
    messages = reduced.messages;
    current = fitSnapshot({ ...common, messages });
    stages.push(freeze({ name, changedMessages: reduced.changed, beforeInputTokens: before.inputTokens, afterInputTokens: current.inputTokens, savedTokens: Math.max(0, before.inputTokens - current.inputTokens), fitAfter: current.status }));
  }
  const status = current.status;
  const reason = status === CONTEXT_FIT_STATUS.PASS ? "CONTEXT_FITS_TARGET" : "CONTEXT_CANNOT_FIT_WITH_SAFE_LOCAL_REDUCTIONS";
  const proof = {
    version: CONTEXT_GOVERNOR_VERSION,
    kind: "CONTEXT_FIT_PROOF",
    status,
    reason,
    provider: current.provider,
    model: current.model,
    initial,
    final: current,
    reductions: stages,
    reductionOrder: [...CONTEXT_REDUCTION_ORDER],
    requiresConversationCompaction: status === CONTEXT_FIT_STATUS.BLOCKED,
    routeSwitchPermitted: false,
  };
  const proofDigest = hash(JSON.stringify(proof));
  return freeze({ messages, proof: freeze({ ...proof, proofDigest }) });
}

export function contextFitMetadata(result) {
  if (!result?.proof || !/^[0-9a-f]{64}$/u.test(result.proof.proofDigest ?? "")) fail("context_proof_invalid");
  const proof = result.proof;
  return freeze({
    kind: "context_fit", version: proof.version, status: proof.status, reason: proof.reason,
    provider: proof.provider, model: proof.model, contextWindow: proof.final.contextWindow,
    reserveOutputTokens: proof.final.reserveOutputTokens, safetyTokens: proof.final.safetyTokens,
    usableInputTokens: proof.final.usableInputTokens, initialInputTokens: proof.initial.inputTokens,
    finalInputTokens: proof.final.inputTokens, messageCount: proof.final.messageCount, toolCount: proof.final.toolCount,
    components: proof.final.components, reductions: proof.reductions, requiresConversationCompaction: proof.requiresConversationCompaction,
    routeSwitchPermitted: proof.routeSwitchPermitted, proofDigest: proof.proofDigest,
  });
}

export function renderContextFit(result) {
  const metadata = contextFitMetadata(result);
  return [
    `Context Fit: ${metadata.status} (${metadata.reason})`,
    `Target: ${metadata.provider}/${metadata.model}`,
    `Input: ${metadata.finalInputTokens.toLocaleString()} / ${metadata.usableInputTokens.toLocaleString()} usable tokens`,
    `Reserved output/safety: ${metadata.reserveOutputTokens.toLocaleString()} / ${metadata.safetyTokens.toLocaleString()} tokens`,
    `Schemas/messages: ${metadata.components.toolSchemaTokens.toLocaleString()} / ${(metadata.finalInputTokens - metadata.components.systemPromptTokens - metadata.components.toolSchemaTokens).toLocaleString()} tokens`,
    `Reductions: ${metadata.reductions.length ? metadata.reductions.map((entry) => `${entry.name}:${entry.savedTokens}`).join(", ") : "none"}`,
    metadata.status === CONTEXT_FIT_STATUS.BLOCKED ? "Action: compact or hand off the conversation, or explicitly select a policy-compatible larger-context target; no provider request was authorized." : `Proof: ${metadata.proofDigest.slice(0, 16)}`,
  ].join("\n");
}
