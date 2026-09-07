#!/usr/bin/env node
import { compactToolText } from '../lib/output-optimizer.mjs';

const fixture = [];
for (let index = 0; index < 5000; index += 1) {
  fixture.push(index % 777 === 0 ? `ERROR fixture-${index}: deterministic diagnostic` : `build row ${index % 80}: unchanged progress`);
}
const input = fixture.join('\n');
const iterations = 100;
const started = process.hrtime.bigint();
let output;
for (let index = 0; index < iterations; index += 1) output = compactToolText(input);
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
const report = {
  fixtureLines: fixture.length,
  inputChars: input.length,
  outputChars: output.text.length,
  characterReductionPercent: Number((100 * (1 - output.text.length / input.length)).toFixed(2)),
  iterations,
  meanMilliseconds: Number((elapsedMs / iterations).toFixed(3)),
  retainedDiagnostics: /ERROR fixture-2331/u.test(output.text),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.retainedDiagnostics || report.characterReductionPercent < 70) process.exit(1);
