import { createHash } from "node:crypto";
import { classifyDelegationFailure } from "./delegation-failure.mjs";
import { canonicalExecutedRoute } from "./model-policy.mjs";

const SPAWN_BUDGET_ERROR = /subagent spawn limit|spawn budget|INSUFFICIENT_SUBAGENT_SPAWN_BUDGET|ATOMIC_SUBAGENT_SPAWN_BUDGET_EXHAUSTED/iu;

export function delegationWasLaunched(response) {
  if (response?.status === "completed") return true;
  return [response?.runId, response?.model, response?.thinking, response?.launchContractDigest]
    .some((value) => typeof value === "string" && value.length > 0);
}

export function delegationFailureReason(response) {
  const message = `${response?.error ?? ""} ${response?.message ?? ""}`;
  if (SPAWN_BUDGET_ERROR.test(message)) return "SUBAGENT_SPAWN_BUDGET_EXHAUSTED";
  return undefined;
}

function schemaFieldNames(schema, names = new Set(), depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 8) return names;
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) {
      if (/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(name)) names.add(name);
      schemaFieldNames(child, names, depth + 1);
    }
  }
  schemaFieldNames(schema.items, names, depth + 1);
  return names;
}

function safeFieldNames(value, allowedFields) {
  if (!value) return [];
  return [...new Set(String(value).split(/[\s,]+/u).map((entry) => entry.replace(/^["'`\[({]+|["'`\])}.:;]+$/gu, "")).filter((entry) => /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(entry) && allowedFields.has(entry)))].slice(0, 32);
}

function failureDetails(message, allowedFields) {
  const text = String(message ?? "");
  const missing = /missing required (?:property|properties|field|fields)\s*:?\s*([^\n.;]{1,512}?)(?:\s+at path\b|[.;]|$)/iu.exec(text)?.[1];
  const unexpected = /(?:unexpected|additional) (?:property|properties|field|fields)\s*:?\s*([^\n.;]{1,512}?)(?:\s+at path\b|[.;]|$)/iu.exec(text)?.[1];
  const pathMatch = /(?:instance path|validation path|at path)\s*:?\s*(\/[A-Za-z0-9_./-]{0,255})/iu.exec(text)?.[1];
  const pathSegments = pathMatch?.split("/").filter(Boolean) ?? [];
  const safePath = pathMatch && pathSegments.length > 0 && pathSegments.every((segment) => /^\d+$/u.test(segment) || allowedFields.has(segment)) ? pathMatch : null;
  let validationKeyword = null;
  for (const keyword of ["required", "additionalProperties", "type", "enum", "minLength", "items", "parse"]) {
    const token = keyword.replace(/[A-Z]/gu, (letter) => `[-_ ]?${letter.toLowerCase()}`);
    if (new RegExp(`\\b${token}\\b`, "iu").test(text)) {
      validationKeyword = keyword;
      break;
    }
  }
  let parseErrorClass = "unknown";
  if (/missing.+structured.output|did not.+structured result|structured.output.+call/iu.test(text)) parseErrorClass = "missing_structured_output";
  else if (/json.+(?:parse|syntax)|unexpected token|unterminated/iu.test(text)) parseErrorClass = "json_parse_error";
  else if (/plain json|not plain json/iu.test(text)) parseErrorClass = "invalid_plain_json";
  else if (/too large|exceeds.+(?:mib|kib|bytes)/iu.test(text)) parseErrorClass = "result_too_large";
  else if (/schema|structured.output|structured result/iu.test(text)) parseErrorClass = "schema_validation_error";
  return { validationKeyword, validationPath: safePath, missingRequiredFields: safeFieldNames(missing, allowedFields), unexpectedFieldNames: safeFieldNames(unexpected, allowedFields), parseErrorClass };
}

export function structuredOutputFailureMetadata(route, response, options = {}) {
  const rawOutput = typeof options.rawOutput === "string" ? options.rawOutput : null;
  const allowedFields = schemaFieldNames(options.schema);
  return Object.freeze({
    failureStage: response?.launchStatus === "launched" && response?.routeAttested === true ? "postlaunch_model_output_validation" : "prelaunch_schema_validation",
    schemaVersion: "native-json-schema-v1",
    ...failureDetails(response?.error ?? response?.message, allowedFields),
    provider: typeof route?.model === "string" ? route.model.split("/")[0] : null,
    model: typeof route?.model === "string" ? route.model : null,
    thinking: typeof route?.thinking === "string" ? route.thinking : null,
    attempt: Number.isSafeInteger(options.attempt) && options.attempt >= 1 ? options.attempt : null,
    outputLength: rawOutput === null ? null : Buffer.byteLength(rawOutput, "utf8"),
    rawOutputDigest: rawOutput === null ? null : createHash("sha256").update(rawOutput).digest("hex"),
  });
}

export function canonicalizeDelegationResponse(route, response, options = {}) {
  const launched = delegationWasLaunched(response);
  let canonicalResponse;
  if (launched) {
    try {
      canonicalResponse = { ...canonicalExecutedRoute(route, response), launchStatus: "launched", routeAttested: true };
    } catch (error) {
      canonicalResponse = {
        ...response,
        status: "protocol_rejected",
        launchStatus: "launched",
        routeAttested: false,
        error: `model route attestation rejected: ${error instanceof Error ? error.message : "unknown error"}`,
      };
    }
  } else {
    canonicalResponse = {
      ...response,
      launchStatus: "not_launched",
      routeAttested: false,
      modelCalls: 0,
    };
  }
  if (canonicalResponse.status !== "completed") {
    // The bridge/provider does not own controller failure taxonomy or evidence.
    // Strip any injected lookalike fields before local classification.
    delete canonicalResponse.failureCategory;
    delete canonicalResponse.failureMetadata;
    canonicalResponse.failureCategory = classifyDelegationFailure(canonicalResponse);
    canonicalResponse.failureReason = delegationFailureReason(canonicalResponse);
    if (["STRUCTURED_OUTPUT_POLICY_ERROR", "STRUCTURED_OUTPUT_MODEL_INVALID"].includes(canonicalResponse.failureCategory)) {
      canonicalResponse.failureMetadata = structuredOutputFailureMetadata(route, canonicalResponse, options);
    }
  }
  return canonicalResponse;
}
