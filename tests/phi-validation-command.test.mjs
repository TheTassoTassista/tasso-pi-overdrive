import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsValidationCandidates, runValidationCommand } from '../platform/windows/validation-process.mjs';
test('validation lookup accepts only absolute PATH executables, not cwd, wrappers or shell input',()=>{
  assert.deepEqual(windowsValidationCandidates('git',{PATH:'relative;.;;C:\\Program Files\\Git\\cmd;D:\\tools'}),['C:\\Program Files\\Git\\cmd\\git.exe','D:\\tools\\git.exe']);
  assert.deepEqual(windowsValidationCandidates('GIT.EXE',{Path:'C:\\tools'}),['C:\\tools\\GIT.EXE']);
  for(const command of ['../git','git.cmd','git & whoami','C:\\git.exe','git\0'])assert.throws(()=>windowsValidationCandidates(command,{PATH:'C:\\tools'}),/COMMAND_UNAVAILABLE/u);
  assert.throws(()=>windowsValidationCandidates('git',{PATH:'C:\\tools\0'}),/COMMAND_UNAVAILABLE/u);
  assert.throws(()=>windowsValidationCandidates('git',{PATH:Array(130).fill('C:\\tools').join(';')}),/COMMAND_UNAVAILABLE/u);
  assert.deepEqual(windowsValidationCandidates('git',{PATH:'.;relative;\\\\host\\share;C:relative'}),[]);
});
test('native Git prerequisite resolves directly and still executes inside an attested owned Job',{skip:process.platform!=='win32',timeout:15000},async()=>{
  const result=await runValidationCommand('git',['--version'],{cwd:process.cwd()});
  assert.equal(result.status,0);assert.match(result.stdout,/^git version /u);
  assert.equal(result.receipt.scope,'TRUSTED_VALIDATION_JOB_NOT_SANDBOX');assert.equal(result.receipt.jobAttested,true);assert.equal(result.receipt.jobEmptyVerified,true);assert.equal(result.receipt.pipesDrained,true);assert.equal(result.receipt.residualOwnedProcesses,0);
});
