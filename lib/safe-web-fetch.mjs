import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_REDIRECTS = 5;
const USER_AGENT = "tasso-pi-overdrive/1.0";

function normalizedIp(address) {
  const value = address.replace(/^\[|\]$/gu, "").toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
  return mapped ? mapped[1] : value;
}

export function isPublicAddress(address) {
  const value = normalizedIp(address);
  const family = net.isIP(value);
  if (family === 4) {
    const parts = value.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    if (value === "::" || value === "::1" || value.startsWith("::ffff:") || value.startsWith("64:ff9b:") || value.startsWith("2001:0:") || value.startsWith("2001:db8:") || value.startsWith("2002:") || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/u.test(value) || value.startsWith("ff")) return false;
    return true;
  }
  return false;
}

export async function resolvePublicHost(hostname) {
  const cleanHostname = hostname.replace(/^\[|\]$/gu, "");
  if (["localhost", "localhost.localdomain"].includes(cleanHostname.toLowerCase())) throw new Error("private_address");
  if (net.isIP(cleanHostname)) {
    if (!isPublicAddress(cleanHostname)) throw new Error("private_address");
    return { address: cleanHostname, family: net.isIP(cleanHostname) };
  }
  const answers = await dns.lookup(cleanHostname, { all: true, verbatim: true });
  if (!answers.length || answers.some((answer) => !isPublicAddress(answer.address))) throw new Error("private_address");
  return answers[0];
}

function assertUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("invalid_url"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported_scheme");
  if (parsed.username || parsed.password) throw new Error("url_credentials_forbidden");
  return parsed;
}

function isAllowedContentType(value) {
  const type = value.split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || ["application/xml", "application/xhtml+xml", "application/javascript"].includes(type);
}

function requestOnce(url, resolution, { signal, maxBytes, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const request = transport.request(url, {
      method,
      agent: false,
      maxHeaderSize: 16 * 1024,
      headers: { Accept: "text/html,text/plain,application/json,application/xml;q=0.9", "Accept-Encoding": "identity", "User-Agent": USER_AGENT, ...headers },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) callback(null, [resolution]);
        else callback(null, resolution.address, resolution.family);
      },
      signal,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
      if (status >= 300 && status < 400) {
        response.destroy();
        finish(undefined, { status, location, headers: response.headers, body: Buffer.alloc(0) });
        return;
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        finish(new Error("response_too_large"));
        return;
      }
      let received = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          response.destroy();
          finish(new Error("response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(undefined, { status, headers: response.headers, body: Buffer.concat(chunks), location }));
      response.on("error", () => finish(new Error("malformed_response")));
    });
    const abort = () => {
      request.destroy();
      finish(new Error("request_cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    request.on("error", () => finish(new Error(signal?.aborted ? "request_cancelled" : "network_error")));
    request.end(body);
  });
}

export async function requestPublicJson(value, options = {}) {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100), 20000);
  const maxBytes = Math.min(Math.max(options.maxBytes ?? 1024 * 1024, 1024), 1024 * 1024);
  const resolver = options.resolver ?? resolvePublicHost;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortParent, { once: true });
  try {
    const target = assertUrl(value);
    const resolution = await resolver(target.hostname);
    const response = await requestOnce(target, resolution, {
      signal: controller.signal,
      maxBytes,
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
    });
    if (response.status >= 300 && response.status < 400) throw new Error("api_redirect_forbidden");
    if (response.status < 200 || response.status >= 300) throw new Error(`http_status_${response.status}`);
    const contentType = String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json" && !contentType.endsWith("+json")) throw new Error("unsupported_content_type");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(response.body)); }
    catch { throw new Error("malformed_response"); }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(options.signal?.aborted ? "request_cancelled" : "request_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortParent);
  }
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, "")
    .replace(/<style[\s\S]*?<\/style>/giu, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/giu, "")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|br|blockquote|pre|section|article|header|footer|nav)>/giu, "\n")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:nbsp|#160);/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export async function fetchPublicText(value, options = {}) {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100), 20000);
  const maxBytes = Math.min(Math.max(options.maxBytes ?? DEFAULT_MAX_BYTES, 1024), DEFAULT_MAX_BYTES);
  const maxRedirects = Math.min(Math.max(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS, 0), DEFAULT_MAX_REDIRECTS);
  const resolver = options.resolver ?? resolvePublicHost;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortParent, { once: true });
  let current;
  let redirects = 0;
  try {
    current = assertUrl(value);
    for (;;) {
      const resolution = await resolver(current.hostname);
      const response = await requestOnce(current, resolution, { signal: controller.signal, maxBytes });
      if (response.status >= 300 && response.status < 400) {
        if (!response.location) throw new Error("redirect_without_location");
        if (redirects >= maxRedirects) throw new Error("redirect_limit");
        const next = assertUrl(new URL(response.location, current).href);
        if (current.protocol === "https:" && next.protocol !== "https:") throw new Error("redirect_downgrade");
        current = next;
        redirects += 1;
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`http_status_${response.status}`);
      const contentType = String(response.headers["content-type"] ?? "");
      if (!isAllowedContentType(contentType)) throw new Error("unsupported_content_type");
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(response.body);
      const extracted = options.raw || !contentType.toLowerCase().includes("html") ? decoded : htmlToText(decoded);
      const output = Buffer.byteLength(extracted, "utf8") <= 65536 ? extracted : `${Buffer.from(extracted, "utf8").subarray(0, 65536).toString("utf8")}\n\n[bounded at 64 KiB]`;
      return {
        text: output,
        details: {
          status: "PASS",
          final_url: current.href,
          redirects,
          content_type: contentType.split(";", 1)[0].toLowerCase(),
          received_bytes: response.body.length,
          truncated: Buffer.byteLength(extracted, "utf8") > 65536,
        },
      };
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(options.signal?.aborted ? "request_cancelled" : "request_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortParent);
  }
}
