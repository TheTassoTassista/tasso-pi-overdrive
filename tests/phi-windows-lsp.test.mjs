import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { reserveWindowsWorker, bindWindowsWorker } from '../lib/phi-worker-authority.mjs';
import { resolveTaskPolicy } from '../lib/task-governor.mjs';
import { executeCodingTool, executeCodingLsp, requireCodingBackend } from '../platform/shared/coding-execution.mjs';
import { windowsJsonLspAssets, WINDOWS_JSON_LSP } from '../platform/windows/lsp-runtime.mjs';
import { validateWindowsBrokerRequest, runWindowsSecureBroker } from '../platform/windows/secure-broker.mjs';
import { draftContentDigest } from '../lib/phi-worker-draft.mjs';
import { windowsRecoveryStatus } from '../platform/windows/process.mjs';
import { diagnosticNativeBody } from './phi-current-failure-diagnostic.mjs';

const runtime = path.resolve(import.meta.dirname,'../runtime/lsp');
const native = { skip:process.platform!=='win32',timeout:60000 };
function fixture(task='Fix JSON configuration code and test diagnostics') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'phi-native-lsp-')),project=path.join(root,'project');fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'config.json'),'{}');
  fs.writeFileSync(path.join(project,'edit.cjs'),"require('fs').writeFileSync('config.json','{\"changed\": }');console.log('EDITED');");
  const privateFile=path.join(root,'private.json');fs.writeFileSync(privateFile,JSON.stringify({required:['PRIVATE_SENTINEL_NEVER_IN_RESULT']}));
  const sessionId=randomUUID();
  const reservation=reserveWindowsWorker({executionId:randomUUID(),parentSessionId:randomUUID(),cwd:project,task,taskPolicy:resolveTaskPolicy({task})});
  const token=bindWindowsWorker({cwd:project,task:'Task: '+task,sessionId});
  return{root,project,privateFile,reservation,sessionId,token,context:{workerAuthority:token,sessionId,runtime},close:()=>{reservation.revoke();fs.rmSync(root,{recursive:true,force:true});}};
}
function assertReceipt(r) {
  assert.equal(r.profile,'LSP_READ_ONLY');assert.equal(r.operation,'lsp');assert.equal(r.tokenVerified,true);assert.equal(r.jobAttested,true);
  assert.equal(r.targetStarted,true);assert.equal(r.jobEmptyVerified,true);assert.equal(r.cleanup,'PASS');assert.equal(r.projectPublished,false);
}
test('LSP request requires fixed least-privilege profile, opaque draft and registered argv',()=>{
  const request={version:1,executable:{path:'C:/tools/node.exe',sha256:'a'.repeat(64)},argv:[...WINDOWS_JSON_LSP.argv],cwd:'.',environment:{CI:'1'},profile:'LSP_READ_ONLY',
    grants:{workspace:{'config.json':'{}'},assets:{}},network:'DENY',timeoutMs:1000,guardianPid:process.pid,context:{sessionId:'a'.repeat(32),operation:'lsp',role:'worker'},
    draft:{id:'b'.repeat(32),revision:1,digest:'c'.repeat(64)},lsp:{path:'config.json',onWrite:true}};
  assert.deepEqual(validateWindowsBrokerRequest(request),request);
  for(const patch of[{profile:'EDIT'},{profile:'READ_ONLY'},{context:{...request.context,operation:'safe-exec'}},{lsp:{path:'../private.json',onWrite:false}},{lsp:{path:'config.json',onWrite:'true'}},{argv:['--eval','anything']},{grants:{workspace:request.grants.workspace,assets:{'secret.key':'x'}}}])assert.throws(()=>validateWindowsBrokerRequest({...request,...patch}),/BROKER_/u);
  const noDraft={...request};delete noDraft.draft;assert.throws(()=>validateWindowsBrokerRequest(noDraft),/BROKER_/u);
  if(process.platform==='win32')assert.throws(()=>requireCodingBackend('lsp'),/BACKEND_UNAVAILABLE/u); // whole Windows autonomy gate remains closed
});
test('Linux cannot invoke the native LSP or choose a Windows fallback',{skip:process.platform==='win32'},async()=>{
  await assert.rejects(executeCodingLsp('.', {operation:'diagnostics',path:'config.json'},{}),/BACKEND_UNAVAILABLE/u);
});
test('LSP runtime closure is pinned, bounded, no-follow and version checked without executing packages',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'phi-lsp-runtime-'));try{
    const pkg=path.join(root,'node_modules',WINDOWS_JSON_LSP.package);fs.mkdirSync(path.dirname(path.join(root,'node_modules',WINDOWS_JSON_LSP.entry)),{recursive:true});
    fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({packages:{['node_modules/'+WINDOWS_JSON_LSP.package]:{version:'4.10.0'}}}));
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'4.10.0'}));
    const entry=path.join(root,'node_modules',WINDOWS_JSON_LSP.entry);fs.writeFileSync(entry,"require('node:fs');module.exports=42;");
    const assets=windowsJsonLspAssets(root);assert.equal(assets.fileCount,2);assert.ok(assets.bytes<1024);assert.match(assets.digest,/^[0-9a-f]{64}$/u);
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'4.9.0'}));assert.throws(()=>windowsJsonLspAssets(root),/RUNTIME_REJECTED/u);
    fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({version:'4.10.0'}));
    fs.linkSync(entry,path.join(root,'alias.js'));assert.throws(()=>windowsJsonLspAssets(root),/RUNTIME_REJECTED/u);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Task/Tool governors cannot gain LSP authority from a tool operation field',()=>{
  const item=fixture('Read a note');try{
    // Pure admission invariant also runs on Linux, without claiming native proof.
    return import('../lib/phi-worker-authority.mjs').then(({admitWindowsWorkerTool})=>{
      assert.throws(()=>admitWindowsWorkerTool(item.token,{cwd:item.project,sessionId:item.sessionId,operation:'lsp'}),/CAPABILITY_DENIED/u);
    }).finally(item.close);
  }catch(e){item.close();throw e;}
});
test('native real JSON LSP sees earlier Worker edit, same logical draft and on-write diagnostics',native,async()=>{
  const item=fixture();try{
    const before=await executeCodingLsp(item.project,{operation:'diagnostics',path:'config.json'},item.context);assert.equal(before.status,'PASS',JSON.stringify(before));assert.equal(before.count,0);assertReceipt(before.receipt);
    const edit=await executeCodingTool({program:'node',args:['edit.cjs'],cwd:item.project,timeoutMs:8000},{operation:'safe-exec',sessionId:item.sessionId,workerAuthority:item.token});assert.equal(edit.code,0);
    const after=await executeCodingLsp(item.project,{operation:'diagnostics',path:'config.json'},{...item.context,onWrite:true});assert.equal(after.status,'PASS',JSON.stringify(after));assert.ok(after.entries.some(x=>x.severity==='Error'));assertReceipt(after.receipt);
    assert.equal(after.receipt.draft.draftId,edit.metadata.draft.draftId);assert.equal(after.receipt.draft.contentDigest,edit.metadata.draft.contentDigest);assert.equal(after.receipt.draft.revision,1);assert.equal(after.receipt.draftBefore.contentDigest,edit.metadata.draft.contentDigest);
    assert.equal(after.receipt.onWrite,true);assert.equal(after.receipt.initialized,true);assert.equal(after.receipt.shutdown,true);assert.equal(fs.readFileSync(path.join(item.project,'config.json'),'utf8'),'{}');
    assert.equal(windowsRecoveryStatus().status,'PASS');
  }finally{item.close();}
});
function brokerRequest(workspace,options={}) {
  return{version:1,executable:{path:process.execPath,sha256:createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex')},argv:[...WINDOWS_JSON_LSP.argv],cwd:'.',environment:{CI:'1',NO_COLOR:'1'},profile:'LSP_READ_ONLY',
    grants:{workspace,assets:windowsJsonLspAssets(runtime).files},network:'DENY',timeoutMs:15000,guardianPid:process.pid,context:{sessionId:randomUUID().replaceAll('-',''),operation:'lsp',role:'worker'},
    draft:{id:randomUUID().replaceAll('-',''),revision:1,digest:draftContentDigest(workspace)},lsp:{path:'config.json',onWrite:true},...options};
}
test('native LSP real file-schema reads only confined files; private schema denied, no network grant',native,async()=>{
  const item=fixture();try{
    // Real server file handler, not a client-side fake diagnostics service.
    const files={'config.json':JSON.stringify({$schema:'./schema.json'}),'schema.json':JSON.stringify({required:['visible']})};
    const positive=await runWindowsSecureBroker(brokerRequest(files));assert.equal(positive.code,0,JSON.stringify(positive.receipt));assert.ok(positive.lspResult.diagnostics.some(d=>/visible/u.test(d.message)));
    const denied=await runWindowsSecureBroker(brokerRequest({'config.json':JSON.stringify({$schema:pathToFileURL(item.privateFile).href})}));assert.equal(denied.code,0,JSON.stringify(denied.receipt));assert.ok(denied.lspResult.diagnostics.some(d=>/EPERM|EACCES|denied|Unable to load/u.test(d.message)));assert.doesNotMatch(JSON.stringify(denied.lspResult),/PRIVATE_SENTINEL_NEVER_IN_RESULT/u);
    assert.equal(denied.receipt.cleanup,'PASS');assert.equal(denied.jobEmptyVerified,true);
  }finally{item.close();}
});
test('native LSP timeout, real target crash and broker death retain failure and owned cleanup',native,
  diagnosticNativeBody('native LSP timeout, real target crash and broker death retain failure and owned cleanup','LSP_TIMEOUT',import.meta.url,async(mark,note)=>{
  for(const mode of['timeout','crash','broker']){
    mark(mode==='timeout'?'LSP_TIMEOUT':mode==='crash'?'LSP_CRASH':'LSP_BROKER_DEATH');
    let target, crashIssued=false;
    const request=brokerRequest({'config.json':'{}'},mode==='timeout'?{timeoutMs:30}:{});
    const abort=new AbortController();
    const result=await runWindowsSecureBroker(request,{signal:abort.signal,onTargetStarted:row=>{target=row;if(mode==='crash'){process.kill(row.childPid,'SIGKILL');crashIssued=true;}if(mode==='broker')abort.abort();}});
    mark(mode==='timeout'?'LSP_TIMEOUT_RESULT':mode==='crash'?'LSP_CRASH_RESULT':'LSP_BROKER_RESULT');
    if(Number.isSafeInteger(result.code)&&result.code>=0&&result.code<=255)note('lspExit',result.code);
    note('targetObserved',Boolean(target));note('jobEmptyVerified',result.jobEmptyVerified===true);note('cleanupPass',result.receipt?.cleanup==='PASS');
    // Never print server stdout/stderr, paths or draft contents. Preserve only
    // the native owner's fixed failure code/phase so 70 cannot masquerade as
    // timeout proof or discard the reason when the same control fails in-suite.
    const nativeFailure=result.nativeFailure??null;
    console.log(JSON.stringify({control:'LSP_FAILURE',mode,code:result.code,receipt:result.receipt,jobEmptyVerified:result.jobEmptyVerified,targetObserved:Boolean(target),crashIssued,nativeFailure}));
    assert.notEqual(result.code,0);assert.equal(result.receipt.cleanup,'PASS');assert.equal(result.lspResult??null,null);
    if(mode==='timeout')assert.equal(result.code,124);
    if(mode==='broker')assert.equal(result.code,125);
    if(mode==='crash'){assert.equal(crashIssued,true);assert.equal(result.receipt.targetStarted,true);assert.equal(result.jobEmptyVerified,true);}
    if(target)assert.throws(()=>process.kill(target.childPid,0),e=>e.code==='ESRCH');
    assert.equal(windowsRecoveryStatus().status,'PASS');
  }
}));
test('native LSP revocation cannot replace prior edited draft or downgrade to host execution',native,async()=>{
  const item=fixture();try{
    const edit=await executeCodingTool({program:'node',args:['edit.cjs'],cwd:item.project,timeoutMs:8000},{operation:'safe-exec',sessionId:item.sessionId,workerAuthority:item.token});assert.equal(edit.code,0);
    const before=item.reservation.status().draft;item.reservation.revoke();
    await assert.rejects(executeCodingLsp(item.project,{operation:'diagnostics',path:'config.json'},item.context),/AUTHORITY_UNAVAILABLE/u);
    const after=item.reservation.status().draft;assert.equal(after.draftId,before.draftId);assert.equal(after.contentDigest,before.contentDigest);assert.equal(after.payloadCleared,true);assert.equal(fs.readFileSync(path.join(item.project,'config.json'),'utf8'),'{}');
  }finally{item.close();}
});
