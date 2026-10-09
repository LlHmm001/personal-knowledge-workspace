import test from 'node:test'
import assert from 'node:assert/strict'
import { firstCutoverTransaction } from '../../deploy/site/first-cutover-transaction.mjs'
const OLD='0.1.2-pkw.4',NEW='0.1.9-pkw.1'
function fixture() {
  const order=[],report={},controller=new AbortController();let running='old',installed=false
  const accepted=(version,capture=false)=>({ok:true,enforcing:true,servingVersion:version,baseline:capture?{noteId:'n',attachmentId:'a'}:undefined,checks:Object.fromEntries(['authenticated','instanceConfirmed','accountConfirmed','spaceConfirmed','noteReadable','fullBodyVerified','fullMarkdownVerified','fullAttachmentVerified',capture?'baselineCaptured':'baselineMatched'].map(k=>[k,true]))})
  const hooks={
    preflight:async()=>{order.push('preflight')},capture:async version=>{order.push(`capture:${version}`);return accepted(version,true)},
    stop:async()=>{order.push(`stop:${running}`);running=null;return{ok:true}},
    probeStopped:async()=>{order.push(`probe:${running}`);return{known:true,stopped:running===null}},
    backup:async()=>{assert.equal(running,null);order.push('backup');return{ok:true,sourceVerified:true,cleanupConfirmed:true,manifestSha256:'a'.repeat(64)}},
    install:async()=>{assert.equal(running,null);order.push('install');installed=true},
    restore:async()=>{assert.equal(running,null);order.push('restore');installed=false},
    start:async version=>{assert.equal(running,null);assert.equal(installed,version===NEW);running=version===NEW?'new':'old';order.push(`start:${running}`)},
    verify:async(baseline,version)=>{assert.deepEqual(baseline,{noteId:'n',attachmentId:'a'});assert.equal(running,version===NEW?'new':'old');order.push(`verify:${running}`);return accepted(version)},
    checkDsh:async()=>{order.push('dsh')},
  }
  return {hooks,report,order,controller,save:async()=>{},signal:controller.signal,state:()=>({running,installed}),setState:(r,i)=>{running=r;installed=i},accepted}
}
test('first cutover uses offline backup, installs only after fresh stop evidence, and enforces old-content acceptance',async()=>{
 const f=fixture();await firstCutoverTransaction(f)
 assert.equal(f.report.status,'ACTIVATED_VERIFIED')
 assert.deepEqual(f.order,['preflight',`capture:${OLD}`,'stop:old','probe:null','backup','probe:null','install','probe:null','start:new','verify:new','dsh'])
 assert.deepEqual(f.state(),{running:'new',installed:true})
})
test('first cutover never stops on invalid existing-account acceptance',async()=>{
 const f=fixture();f.hooks.capture=async()=>({ok:true});await assert.rejects(firstCutoverTransaction(f));assert.equal(f.report.status,'STOPPED_BEFORE_SERVICE_ACTION');assert.deepEqual(f.state(),{running:'old',installed:false})
})
test('unknown or still-running initial stop cannot install, restore, or start a second writer',async()=>{
 for(const proof of [{known:false,stopped:false},{known:true,stopped:false}]){const f=fixture();f.hooks.stop=async()=>({ok:false});f.hooks.probeStopped=async()=>proof;await assert.rejects(firstCutoverTransaction(f));assert.equal(f.report.status,'RECOVERY_BLOCKED_OR_UNVERIFIED');assert.equal(f.order.includes('install'),false);assert.equal(f.order.includes('restore'),false);assert.equal(f.state().running,'old')}
})
test('failed stop with confirmed disappearance restores and verifies original, never activates',async()=>{
 const f=fixture(),stop=f.hooks.stop;f.hooks.stop=async()=>{await stop();return{ok:false}};await assert.rejects(firstCutoverTransaction(f),{code:'PKW_FIRST_ROLLED_BACK'});assert.equal(f.order.includes('backup'),false);assert.deepEqual(f.state(),{running:'old',installed:false})
})
test('backup failure resumes unchanged old code only after fresh disappearance evidence',async()=>{
 const f=fixture();f.hooks.backup=async()=>{throw new Error('partial backup retained')};await assert.rejects(firstCutoverTransaction(f),{code:'PKW_FIRST_ROLLED_BACK'});assert.equal(f.order.includes('install'),false);assert.equal(f.report.error.message,'partial backup retained');assert.equal(f.state().running,'old')
})
test('backup with a remaining writer or lock blocks recovery and never starts old',async()=>{
 const f=fixture(),probe=f.hooks.probeStopped;let blocked=false;f.hooks.backup=async()=>{blocked=true;throw new Error('worker interrupted')};f.hooks.probeStopped=async()=>blocked?{known:false,stopped:false}:probe();await assert.rejects(firstCutoverTransaction(f));assert.equal(f.report.status,'RECOVERY_BLOCKED_OR_UNVERIFIED');assert.equal(f.order.includes('restore'),false)
})
test('candidate rejection stops that live instance before restoring original references and preserves new data',async()=>{
 const f=fixture(),verify=f.hooks.verify;f.hooks.verify=async(b,v)=>v===NEW?{ok:false}:verify(b,v);await assert.rejects(firstCutoverTransaction(f),{code:'PKW_FIRST_ROLLED_BACK'});assert.deepEqual(f.order.slice(-6),['stop:new','probe:null','restore','start:old','verify:old','dsh']);assert.deepEqual(f.state(),{running:'old',installed:false});assert.equal(Object.hasOwn(f.hooks,'restoreDatabase'),false)
})
test('partial candidate start still requires stopping the created process before recovery',async()=>{
 const f=fixture(),start=f.hooks.start;f.hooks.start=async v=>{await start(v);if(v===NEW)throw new Error('started then failed')};await assert.rejects(firstCutoverTransaction(f),{code:'PKW_FIRST_ROLLED_BACK'});assert.ok(f.order.indexOf('stop:new')<f.order.indexOf('restore'))
})
test('candidate stop uncertainty preserves new references and forbids starting old',async()=>{
 const f=fixture(),verify=f.hooks.verify,stop=f.hooks.stop;f.hooks.verify=async(b,v)=>v===NEW?{ok:false}:verify(b,v);let calls=0;f.hooks.stop=async()=>++calls===1?stop():{ok:false};await assert.rejects(firstCutoverTransaction(f));assert.deepEqual(f.state(),{running:'new',installed:true});assert.equal(f.order.includes('restore'),false)
})
test('reference installation failure with proven stop restores original code without any database restore',async()=>{
 const f=fixture(),install=f.hooks.install;f.hooks.install=async()=>{await install();throw new Error('reload failed')};await assert.rejects(firstCutoverTransaction(f),{code:'PKW_FIRST_ROLLED_BACK'});assert.deepEqual(f.state(),{running:'old',installed:false});assert.equal(f.order.includes('start:new'),false)
})
test('rollback acceptance or DSH drift cannot claim verified restoration',async()=>{
 const f=fixture();f.hooks.verify=async()=>({ok:false});await assert.rejects(firstCutoverTransaction(f));assert.equal(f.report.status,'RECOVERY_BLOCKED_OR_UNVERIFIED');assert.equal(f.state().running,'old')
})
test('interrupt after candidate startup stops and restores original without claiming activation',async()=>{
 const f=fixture(),start=f.hooks.start;f.hooks.start=async v=>{await start(v);if(v===NEW)f.controller.abort()};await assert.rejects(firstCutoverTransaction(f),{code:'PKW_FIRST_ROLLED_BACK'});assert.equal(f.state().running,'old')
})
test('manual rollback captures current candidate content and reads it on original instead of restoring database',async()=>{
 const f=fixture();f.setState('new',true);await firstCutoverTransaction({...f,rollbackOnly:true});assert.equal(f.report.status,'ROLLED_BACK_VERIFIED');assert.deepEqual(f.order,['preflight',`capture:${NEW}`,'stop:new','probe:null','restore','start:old','verify:old','dsh']);assert.equal(f.order.includes('backup'),false)
})

test('DSH drift is reported after old PKW is restarted and accepted, without claiming verified recovery',async()=>{
 const f=fixture();f.hooks.checkDsh=async()=>{f.order.push('dsh:changed');throw new Error('DSH identity changed')}
 await assert.rejects(firstCutoverTransaction(f),{code:'PKW_FIRST_RECOVERY_BLOCKED'})
 assert.deepEqual(f.state(),{running:'old',installed:false})
 assert.deepEqual(f.order.slice(-6),['stop:new','probe:null','restore','start:old','verify:old','dsh:changed'])
 assert.equal(f.report.status,'RECOVERY_BLOCKED_OR_UNVERIFIED')
 assert.equal(f.report.recoveryError.message,'DSH identity changed')
})
