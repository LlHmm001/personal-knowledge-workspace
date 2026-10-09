import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dispatchFirstCutover, validateCompatibility } from '../../deploy/first-cutover.mjs'
import { SITE, checkLegacyCompatibility } from '../../deploy/check-legacy-compatibility.mjs'

const sourceSha='b634a58a7953b039dc4ca662eb19eca3363c1ebd'
const work='/LlHmm9527/pkw-first-cutover-Test12/plan'
const credentials='/LlHmm9527/pkw-first-cutover-Test12/credentials.json'
const plan=join(work,'plan.json'),digest='a'.repeat(64)
const preparation=['prepare','--work-dir',work,'--credentials-file',credentials]
const activation=mode=>[mode,'--plan',plan,'--plan-sha256',digest,'--maintenance-approved']
function handlers(){
 const calls=[]
 return {calls,prepare:async options=>{calls.push({handler:'prepare',options});return {status:'FIRST_CUTOVER_PLAN_READY'}},execute:async options=>{calls.push({handler:'execute',options});return {status:options.rollbackOnly?'ROLLED_BACK_VERIFIED':'ACTIVATED_VERIFIED'}}}
}

test('first-cutover public prepare dispatch cannot reach activation even with a valid source and credentials path',async()=>{
 const h=handlers(),signal=new AbortController().signal
 const result=await dispatchFirstCutover(preparation,{sourceSha,signal},h)
 assert.equal(result.status,'FIRST_CUTOVER_PLAN_READY')
 assert.deepEqual(h.calls,[{handler:'prepare',options:{workDir:work,credentialsFile:credentials,sourceSha,signal}}])
})

test('first-cutover refuses activation and rollback without maintenance approval before calling any handler',async()=>{
 for(const mode of ['activate','rollback']){
  const h=handlers()
  await assert.rejects(dispatchFirstCutover(activation(mode).slice(0,-1),{},h),{code:'PKW_FIRST_MAINTENANCE_REQUIRED'})
  assert.deepEqual(h.calls,[])
 }
})

test('first-cutover prepare rejects all execution flags rather than silently ignoring them',async()=>{
 for(const extra of [['--maintenance-approved'],['--plan',plan],['--plan-sha256',digest]]){
  const h=handlers()
  await assert.rejects(dispatchFirstCutover([...preparation,...extra],{sourceSha},h),{code:'PKW_FIRST_USAGE'})
  assert.deepEqual(h.calls,[])
 }
})

test('first-cutover source and path guards reject missing identities, path aliases and credentials outside the scene before effects',async()=>{
 for(const badSource of [undefined,'','b634a58','g'.repeat(40),sourceSha+'\n']){
  const h=handlers()
  await assert.rejects(dispatchFirstCutover(preparation,{sourceSha:badSource},h),{code:'PKW_FIRST_SOURCE_SHA'})
  assert.deepEqual(h.calls,[])
 }
 for(const [badWork,badCredentials] of [[undefined,credentials],[work+'/../plan',credentials],[work.replace('/plan','//plan'),credentials],[work,credentials.replace('Test12','Other')],[work,work+'/credentials.json'],['./plan','./credentials.json']]){
  const h=handlers(),args=['prepare',...(badWork?['--work-dir',badWork]:[]),'--credentials-file',badCredentials]
  await assert.rejects(dispatchFirstCutover(args,{sourceSha},h),{code:'PKW_FIRST_WORK'})
  assert.deepEqual(h.calls,[])
 }
})

test('first-cutover requires a full plan digest and exact scene path before execute',async()=>{
 for(const [badPlan,badDigest] of [[plan,'a'.repeat(63)],[plan,'A'.repeat(64)],[plan+'/../plan.json',digest],['/tmp/pkw-first-cutover-Test12/plan/plan.json',digest],[plan.replace('/plan/','//plan/'),digest]]){
  const h=handlers()
  await assert.rejects(dispatchFirstCutover(['activate','--plan',badPlan,'--plan-sha256',badDigest,'--maintenance-approved'],{},h),{code:'PKW_FIRST_MAINTENANCE_REQUIRED'})
  assert.deepEqual(h.calls,[])
 }
})

test('first-cutover activation and rollback preserve the approved plan and choose distinct execution modes',async()=>{
 for(const mode of ['activate','rollback']){
  const h=handlers(),signal=new AbortController().signal
  await dispatchFirstCutover(activation(mode),{signal},h)
  assert.deepEqual(h.calls,[{handler:'execute',options:{planPath:plan,expectedSha:digest,approved:true,rollbackOnly:mode==='rollback',signal}}])
 }
})

test('first-cutover refuses mixed modes, duplicate options and pre-existing cancellation before effects',async()=>{
 for(const args of [[...activation('activate'),'--work-dir',work],[...preparation,'--work-dir',work],['prepare','activate'],[...preparation,'--unknown']]){
  const h=handlers()
  await assert.rejects(dispatchFirstCutover(args,{sourceSha},h))
  assert.deepEqual(h.calls,[])
 }
 const h=handlers(),controller=new AbortController();controller.abort()
 await assert.rejects(dispatchFirstCutover(preparation,{sourceSha,signal:controller.signal},h),{code:'PKW_FIRST_INTERRUPTED'})
 assert.deepEqual(h.calls,[])
})

async function compatibilityReport(t){
 const parent=await realpath(await mkdtemp(join(tmpdir(),'pkw-first-cli-report-')))
 t.after(()=>rm(parent,{recursive:true,force:true}))
 const inputs={
  old:{runner:SITE.oldRunner,profile:SITE.oldProfile,version:SITE.oldVersion,packages:[{name:'@deepseek-ai/dsh-pkw-web',version:SITE.oldVersion,directory:SITE.oldProfile+'/node_modules/@deepseek-ai/dsh-pkw-web',manifestSha256:'b'.repeat(64),libSha256:'c'.repeat(64),identitySha256:'d'.repeat(64)}]},
  candidate:{runner:SITE.prepared+'/releases/'+SITE.newVersion+'/runner/scripts/serve-collaboration.mjs',profile:SITE.prepared+'/releases/'+SITE.newVersion+'/profile',version:SITE.newVersion,profileSha256:SITE.profileSha256,runnerSha256:SITE.runnerSha256,profileIdentitySha256:'e'.repeat(64),runnerIdentitySha256:'f'.repeat(64)},
 }
 const baseline={dsh:{pid:111,startTicks:'11',NRestarts:0},pkw:{pid:222,startTicks:'22',NRestarts:0}}
 let version
 const processFactory=options=>({start:async()=>{version=options.version;return {pid:123,proof:{confirmed:true},health:{status:200}}},stop:async()=>({ok:true,cleanupConfirmed:true,exit:{exitCode:0,signal:null,spawnError:null}}),state:()=>({closed:true})})
 const clientFactory=async()=>({authenticate:async expected=>({authenticated:true,login:200,session:200,page:200,spaceId:'sp_existing',servingVersion:expected}),writeFixture:async({label})=>({spaceId:'sp_existing',noteId:'note_'+label,attachmentId:'att_'+label,writtenByVersion:version}),verifyFixture:async fixture=>({ok:true,servingVersion:version,spaceId:fixture.spaceId,noteId:fixture.noteId,attachmentId:fixture.attachmentId,downloadStatus:200,linked:true})})
 const previous=process.env.PKW_COMPAT_SOURCE_SHA;process.env.PKW_COMPAT_SOURCE_SHA=sourceSha
 let report
 try{report=await checkLegacyCompatibility({workDir:join(parent,'run')},{allowTestWork:true,observe:async()=>structuredClone(baseline),inspect:async()=>structuredClone(inputs),unusedPort:async()=>41234,processFactory,clientFactory})}
 finally{if(previous===undefined)delete process.env.PKW_COMPAT_SOURCE_SHA;else process.env.PKW_COMPAT_SOURCE_SHA=previous}
 return {report,inputs}
}

test('first-cutover consumes the actual compatibility producer report including per-phase native stop and cross-version reads',async t=>{
 const {report,inputs}=await compatibilityReport(t)
 assert.equal(report.status,'LEGACY_SYNTHETIC_COMPATIBILITY_PASSED')
 assert.equal(validateCompatibility(report,inputs),undefined)
 assert.deepEqual(report.phases.map(p=>p.name),['legacy-write','candidate-read-write','legacy-read-back'])
})

test('first-cutover rejects a success-looking compatibility summary or missing producer evidence',async t=>{
 const {report,inputs}=await compatibilityReport(t)
 for(const mutate of [
  r=>{r.sourceSha='0'.repeat(40)},r=>{r.syntheticOnly=false},r=>{r.cleanupConfirmed=false},r=>{r.inputs.candidate.profileIdentitySha256='0'.repeat(64)},
  r=>{r.phases=r.phases.map(p=>({name:p.name,status:p.status,version:p.version,cleanupConfirmed:true}))},
  r=>{r.phases[0].name='candidate-read-write'},r=>{r.phases[0].auth.authenticated=false},r=>{r.phases[1].stop.ok=false},r=>{r.phases[1].stop.cleanupConfirmed=false},
  r=>{delete r.phases[1].oldRead},r=>{r.phases[2].newRead.ok=false},r=>{r.phases[2]=null},
 ]){
  const value=structuredClone(report);mutate(value)
  assert.throws(()=>validateCompatibility(value,inputs),{code:'PKW_FIRST_COMPATIBILITY'})
 }
 for(const invalid of [null,false,[],{}, {...report,phases:null}])assert.throws(()=>validateCompatibility(invalid,inputs),{code:'PKW_FIRST_COMPATIBILITY'})
})
