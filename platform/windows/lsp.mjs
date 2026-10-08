import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { admitWindowsWorkerTool } from '../../lib/phi-worker-authority.mjs';
import { runWindowsSecureBroker } from './secure-broker.mjs';
import { readWindowsProjectSnapshot, validateWindowsSnapshot } from './coding-tools.mjs';
import { draftContentDigest } from '../../lib/phi-worker-draft.mjs';
import { WINDOWS_JSON_LSP, windowsJsonLspAssets } from './lsp-runtime.mjs';

const fail = code => { throw new Error('PHI_LSP_' + code); };
export async function executeWindowsLsp(cwd, parameters, context) {
  if (process.platform !== 'win32') fail('PLATFORM_UNSUPPORTED');
  if (!context || Object.keys(context).some(k=>!['sessionId','workerAuthority','signal','runtime','onWrite','timeoutMs'].includes(k)) || !Object.hasOwn(context,'workerAuthority')) fail('AUTHORITY_REQUIRED');
  const worker = admitWindowsWorkerTool(context.workerAuthority, { cwd, sessionId: context.sessionId, signal: context.signal, operation: 'lsp' });
  try {
    if (!parameters || Object.keys(parameters).some(k=>!['operation','path'].includes(k)) || parameters.operation !== 'diagnostics' || typeof parameters.path !== 'string' || !parameters.path.endsWith('.json')) fail('CAPABILITY_UNSUPPORTED');
    if (!worker.snapshot || readWindowsProjectSnapshot(cwd).rootIdentity !== worker.expectedRootIdentity) fail('DRAFT_IDENTITY_INVALID');
    const runtime = windowsJsonLspAssets(context.runtime);
    const timeout = context.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000 || context.onWrite !== undefined && typeof context.onWrite !== 'boolean') fail('REQUEST_INVALID');
    const result = await runWindowsSecureBroker({ version: 1, executable: { path: process.execPath, sha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex') },
      argv: [...WINDOWS_JSON_LSP.argv], cwd: '.', environment: { CI:'1', NO_COLOR:'1' }, profile:'LSP_READ_ONLY',
      grants: { workspace: worker.snapshot.files, assets: runtime.files }, network:'DENY', timeoutMs:Math.min(timeout,worker.remainingMs),guardianPid:process.pid,
      context: { sessionId:context.sessionId.replaceAll('-',''),operation:'lsp',role:'worker' },draft:worker.binding,lsp:{path:parameters.path,onWrite:context.onWrite===true}}, {signal:worker.signal});
    const snapshot = result.code === 0 ? validateWindowsSnapshot(result.draftSnapshot) : null;
    if (snapshot && draftContentDigest(snapshot.files) !== worker.binding.digest) fail('DRAFT_IDENTITY_INVALID');
    const settled = worker.finish(snapshot, result.code === 0);
    const success = result.code === 0 && !settled.cancelled;
    if(!settled.cancelled)worker.recordLsp(parameters.path,result.lspResult?.diagnostics,success);
    const receipt = Object.freeze({...result.receipt,productionPath:'semantic_nav',workerAuthority:worker.metadata,draftBefore:worker.before,draft:settled.draft,
      brokerHelperClosed:result.brokerHelperClosed===true,brokerPipesDrained:result.brokerPipesDrained===true,
      jobEmptyVerified:result.jobEmptyVerified??null,projectPublished:false,runtimeDigest:runtime.digest,runtimeFiles:runtime.fileCount,
      initialized:result.lspResult?.initialized??false,shutdown:result.lspResult?.shutdown??false,onWrite:context.onWrite===true});
    const entries = success ? result.lspResult.diagnostics.map(d=>({path:parameters.path,severity:({1:'Error',2:'Warning',3:'Information',4:'Hint'})[d.severity]??'Information',
      message:String(d.message??'').replace(/[\r\n\t]+/gu,' ').slice(0,1000),code:d.code??null,source:'json-language-server',
      start:{line:(d.range?.start?.line??0)+1,character:(d.range?.start?.character??0)+1},end:{line:(d.range?.end?.line??0)+1,character:(d.range?.end?.character??0)+1}})) : [];
    return {status:success?'PASS':'FAIL',error:success?undefined:settled.cancelled?'PHI_LSP_CANCELLED':'PHI_LSP_EXECUTION_FAILED',operation:'diagnostics',language:'json',
      backend:'vscode-langservers-extracted@4.10.0',sandbox:'windows-lpac-job-read-only-no-network',count:entries.length,entries,receipt};
  } catch(error) { worker.recordLspFailure(parameters?.path);throw error; }
  finally { worker.release(); }
}
