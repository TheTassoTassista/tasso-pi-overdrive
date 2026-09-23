import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneKnownTraceLogs, resolveRetentionDays } from "../lib/trace-retention.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function createState() {
  const stateHome = mkdtempSync(path.join(tmpdir(), "pi-trace-retention-"));
  const overdrive = path.join(stateHome, "pi-overdrive");
  for (const name of ["traces", "mcp-traces", "editor-bridge", "launcher"]) mkdirSync(path.join(overdrive, name), { recursive: true, mode: 0o700 });
  return { stateHome, overdrive };
}

function fileAt(file, contents, mtimeMs) {
  writeFileSync(file, contents, { mode: 0o600 });
  const date = new Date(mtimeMs);
  utimesSync(file, date, date);
}

test("retention removes only old known trace/log files and keeps recent and exact-cutoff files", async () => {
  const fixture = createState();
  const nowMs = Date.UTC(2026, 8, 12, 12, 0, 0);
  try {
    const oldTrace = path.join(fixture.overdrive, "traces", "old.jsonl");
    const malformedTrace = path.join(fixture.overdrive, "traces", "malformed.jsonl");
    const recentTrace = path.join(fixture.overdrive, "traces", "recent.jsonl");
    const cutoffTrace = path.join(fixture.overdrive, "traces", "cutoff.jsonl");
    const oldMcp = path.join(fixture.overdrive, "mcp-traces", "mcp.jsonl");
    const oldEditor = path.join(fixture.overdrive, "editor-bridge", "123-00000000-0000-4000-8000-000000000000.jsonl");
    const oldLauncher = path.join(fixture.overdrive, "launcher", "omniroute-20260101.log");
    const foreignLog = path.join(fixture.overdrive, "launcher", "application.log");
    fileAt(oldTrace, '{"event":"old"}\n', nowMs - 31 * DAY_MS);
    fileAt(malformedTrace, "not-json\n", nowMs - 31 * DAY_MS);
    fileAt(recentTrace, '{"event":"recent"}\n', nowMs - DAY_MS);
    fileAt(cutoffTrace, '{"event":"cutoff"}\n', nowMs - 30 * DAY_MS);
    fileAt(oldMcp, "{}\n", nowMs - 31 * DAY_MS);
    fileAt(oldEditor, "{}\n", nowMs - 31 * DAY_MS);
    fileAt(oldLauncher, "old\n", nowMs - 31 * DAY_MS);
    fileAt(foreignLog, "foreign\n", nowMs - 31 * DAY_MS);
    const summary = await pruneKnownTraceLogs({ stateHome: fixture.stateHome, days: 30, nowMs });
    assert.equal(summary.status, "PASS");
    assert.equal(summary.removed, 5);
    for (const removed of [oldTrace, malformedTrace, oldMcp, oldEditor, oldLauncher]) assert.equal(existsSync(removed), false, removed);
    for (const kept of [recentTrace, cutoffTrace, foreignLog]) assert.equal(existsSync(kept), true, kept);
  } finally {
    rmSync(fixture.stateHome, { recursive: true, force: true });
  }
});

test("retention never follows symlinks, recurses, or touches foreign names", async () => {
  const fixture = createState();
  const outside = mkdtempSync(path.join(tmpdir(), "pi-trace-outside-"));
  const nowMs = Date.UTC(2026, 8, 12, 12, 0, 0);
  try {
    const outsideFile = path.join(outside, "outside.jsonl");
    fileAt(outsideFile, "outside\n", nowMs - 31 * DAY_MS);
    symlinkSync(outsideFile, path.join(fixture.overdrive, "traces", "linked.jsonl"));
    mkdirSync(path.join(fixture.overdrive, "traces", "nested"));
    const nested = path.join(fixture.overdrive, "traces", "nested", "old.jsonl");
    fileAt(nested, "nested\n", nowMs - 31 * DAY_MS);
    fileAt(path.join(fixture.overdrive, "traces", "source.ts"), "source\n", nowMs - 31 * DAY_MS);
    const summary = await pruneKnownTraceLogs({ stateHome: fixture.stateHome, days: 30, nowMs });
    assert.equal(summary.removed, 0);
    assert.equal(existsSync(outsideFile), true);
    assert.equal(existsSync(nested), true);
    assert.equal(existsSync(path.join(fixture.overdrive, "traces", "source.ts")), true);
  } finally {
    rmSync(fixture.stateHome, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("retention detects a pathname swap after final validation without touching the symlink target", async () => {
  const fixture = createState();
  const outside = mkdtempSync(path.join(tmpdir(), "pi-trace-race-outside-"));
  const nowMs = Date.UTC(2026, 8, 12, 12, 0, 0);
  const oldTrace = path.join(fixture.overdrive, "traces", "race.jsonl");
  const heldTrace = path.join(fixture.overdrive, "traces", "race-held");
  const outsideFile = path.join(outside, "outside.jsonl");
  try {
    fileAt(oldTrace, "old trace\n", nowMs - 31 * DAY_MS);
    fileAt(outsideFile, "outside-safe\n", nowMs - 31 * DAY_MS);
    await assert.rejects(() => pruneKnownTraceLogs({
      stateHome: fixture.stateHome,
      days: 30,
      nowMs,
      beforeUnlink: (file) => {
        assert.equal(file, oldTrace);
        renameSync(oldTrace, heldTrace);
        symlinkSync(outsideFile, oldTrace);
      },
    }), /identity changed during retention unlink/u);
    assert.equal(readFileSync(outsideFile, "utf8"), "outside-safe\n");
    assert.equal(readFileSync(heldTrace, "utf8"), "old trace\n");
    assert.equal(existsSync(oldTrace), false);
  } finally {
    rmSync(fixture.stateHome, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("retention remains anchored to the opened known directory when its pathname is replaced", async () => {
  const fixture = createState();
  const outside = mkdtempSync(path.join(tmpdir(), "pi-trace-dir-race-outside-"));
  const nowMs = Date.UTC(2026, 8, 12, 12, 0, 0);
  const traceDirectory = path.join(fixture.overdrive, "traces");
  const heldDirectory = path.join(fixture.overdrive, "traces-held");
  const oldTrace = path.join(traceDirectory, "race.jsonl");
  const outsideFile = path.join(outside, "race.jsonl");
  try {
    fileAt(oldTrace, "old trace\n", nowMs - 31 * DAY_MS);
    fileAt(outsideFile, "outside-safe\n", nowMs - 31 * DAY_MS);
    const summary = await pruneKnownTraceLogs({
      stateHome: fixture.stateHome,
      days: 30,
      nowMs,
      beforeUnlink: (file) => {
        assert.equal(file, oldTrace);
        renameSync(traceDirectory, heldDirectory);
        symlinkSync(outside, traceDirectory);
      },
    });
    assert.equal(summary.removed, 1);
    assert.equal(readFileSync(outsideFile, "utf8"), "outside-safe\n");
    assert.equal(existsSync(path.join(heldDirectory, "race.jsonl")), false);
  } finally {
    rmSync(fixture.stateHome, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("missing, symlinked, capped, and malformed configuration states fail safely", async () => {
  const missing = mkdtempSync(path.join(tmpdir(), "pi-trace-missing-"));
  const linked = mkdtempSync(path.join(tmpdir(), "pi-trace-linked-"));
  const outside = mkdtempSync(path.join(tmpdir(), "pi-trace-linked-outside-"));
  try {
    assert.equal((await pruneKnownTraceLogs({ stateHome: missing, days: 30 })).status, "SKIPPED_OVERDRIVE_ROOT");
    mkdirSync(path.join(linked, "pi-overdrive"));
    symlinkSync(outside, path.join(linked, "pi-overdrive", "traces"));
    const linkedSummary = await pruneKnownTraceLogs({ stateHome: linked, days: 30 });
    assert.equal(linkedSummary.removed, 0);
    assert.equal(resolveRetentionDays(undefined).days, 30);
    assert.equal(resolveRetentionDays("90").days, 90);
    assert.equal(resolveRetentionDays("0").valid, false);
    assert.equal(resolveRetentionDays("not-a-number").valid, false);
    assert.equal((await pruneKnownTraceLogs({ stateHome: linked, days: "bad" })).status, "SKIPPED_INVALID_CONFIG");
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
