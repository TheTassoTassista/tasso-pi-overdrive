#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmRoot = path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules');
const piRoot = process.env.PI_PACKAGE_ROOT || path.join(npmRoot, '@earendil-works', 'pi-coding-agent');
const piModules = path.join(piRoot, 'node_modules');
const tsc = process.env.PI_OVERDRIVE_TSC || path.join(root, 'runtime', 'lsp', 'node_modules', '.bin', 'tsc');
for (const required of [piRoot, piModules, tsc]) {
  if (!existsSync(required)) throw new Error(`typecheck dependency missing: ${required}`);
}

const temp = mkdtempSync(path.join(tmpdir(), 'pi-overdrive-typecheck-'));
const project = path.join(temp, 'project');
try {
  mkdirSync(project, { recursive: true });
  for (const item of ['extensions', 'lib', 'package.json', 'tsconfig.json']) cpSync(path.join(root, item), path.join(project, item), { recursive: true });
  symlinkSync(path.join(root, 'runtime'), path.join(project, 'runtime'), 'dir');
  const modules = path.join(project, 'node_modules');
  mkdirSync(path.join(modules, '@earendil-works'), { recursive: true });
  symlinkSync(piRoot, path.join(modules, '@earendil-works', 'pi-coding-agent'), 'dir');
  for (const name of ['pi-ai', 'pi-agent-core', 'pi-tui']) {
    symlinkSync(path.join(piModules, '@earendil-works', name), path.join(modules, '@earendil-works', name), 'dir');
  }
  for (const name of ['typebox', '@types']) {
    const source = path.join(piModules, name);
    if (existsSync(source)) symlinkSync(source, path.join(modules, name), 'dir');
  }
  const config = JSON.parse(readFileSync(path.join(project, 'tsconfig.json'), 'utf8'));
  config.compilerOptions.typeRoots = [path.join(modules, '@types')];
  writeFileSync(path.join(project, 'tsconfig.json'), `${JSON.stringify(config, null, 2)}\n`);
  const typescriptPath = path.resolve(path.dirname(realpathSync(tsc)), '..', 'lib', 'typescript.js');
  const loaded = await import(pathToFileURL(typescriptPath).href);
  const ts = loaded.default ?? loaded;
  const configPath = path.join(project, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, project);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const diagnostics = [...(configFile.error ? [configFile.error] : []), ...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => project,
      getNewLine: () => '\n',
    }));
    process.exitCode = 1;
  } else {
    process.stdout.write('Extension TypeScript check against installed Pi: PASS\n');
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
