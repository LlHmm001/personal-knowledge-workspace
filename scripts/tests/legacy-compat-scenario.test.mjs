import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkLegacyCompatibility, runCompatibilityScenario } from '../../deploy/check-legacy-compatibility.mjs'

const inputs = {
  old: { runner:'/recorded/old/runner.mjs',profile:'/recorded/old/profile',version:'0.1.2-pkw.4' },
  candidate: { runner:'/prepared/new/runner.mjs',profile:'/prepared/new/profile',version:'0.1.9-pkw.1' },
}
const baseline = { dsh:{pid:111,startTicks:'100',NRestarts:0},pkw:{pid:222,startTicks:'200',NRestarts:0} }
const fault = (code,message=code) => Object.assign(new Error(message),{code})
async function scene(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(),'pkw-compat-scenario-')))
  t.after(()=>rm(parent,{recursive:true,force:true}))
  return {parent,work:join(parent,'run')}
}
function stubs({startFailure,stopFailure,stopThrows,onStop,observe,inspect}={}) {
  const events=[],processOptions=[],clientOptions=[],authArguments=[],written=[]
  let current = null, created=0, active=0
  const processFactory = options => {
    const index=created++, label=['old-1','new','old-2'][index]
    assert.equal(active,0,'the next writer was constructed before the preceding writer stopped')
    processOptions.push(options)
    return {
      async start() {
        events.push(`start:${label}`)
        if(index===startFailure) throw fault('PKW_TEST_START_FAILED')
        assert.equal(active,0);active=1;current=index
        return {pid:1000+index,proof:{confirmed:true},health:{status:200}}
      },
      async stop() {
        events.push(`stop:${label}`);active=0;onStop?.(index)
        if(index===stopThrows) throw fault('PKW_TEST_STOP_THREW')
        return {ok:index!==stopFailure,cleanupConfirmed:true,exit:{exitCode:index===stopFailure?1:0,signal:null}}
      },
      state(){return {pid:1000+index,closed:true,started:current===index}},
    }
  }
  const clientFactory = options => {
    assert.equal(active,1,'authentication client was constructed without an owned started listener')
    const index=current,label=['old-1','new','old-2'][index]
    clientOptions.push(options)
    return {
      async authenticate(version,spaceId) {
        events.push(`auth:${label}`);authArguments.push({version,spaceId})
        if(index>0) assert.equal(spaceId,'sp_owned','later versions must reopen the original owned space')
        return {authenticated:true,spaceId:'sp_owned',servingVersion:version}
      },
      async writeFixture({label:writer}) {
        events.push(`write:${writer}`)
        const value={spaceId:'sp_owned',noteId:`note_${writer}`,attachmentId:`att_${writer}`,writtenByVersion:processOptions[index].version}
        written.push(value);return value
      },
      async verifyFixture(value) {
        assert.ok(written.includes(value),'read-back must receive the exact fixture evidence returned by the writer')
        events.push(`read:${label}:${value.noteId}`)
        return {verified:true,noteId:value.noteId,attachmentId:value.attachmentId}
      },
    }
  }
  return {events,processOptions,clientOptions,authArguments,written,
    dependencies:{processFactory,clientFactory,observe:observe??(async()=>structuredClone(baseline)),inspect:inspect??(async()=>structuredClone(inputs)),unusedPort:async()=>43123,allowTestWork:true}}
}
const expectedEvents=[
  'start:old-1','auth:old-1','write:legacy','stop:old-1',
  'start:new','auth:new','read:new:note_legacy','write:candidate','stop:new',
  'start:old-2','auth:old-2','read:old-2:note_legacy','read:old-2:note_candidate','stop:old-2',
]

test('legacy scenario enforces exact old/new/old ownership and authenticates the same account and space',async t=>{
  const {work}=await scene(t),fake=stubs()
  const result=await checkLegacyCompatibility({workDir:work},fake.dependencies)
  assert.deepEqual(fake.events,expectedEvents)
  assert.equal(result.status,'LEGACY_SYNTHETIC_COMPATIBILITY_PASSED')
  assert.equal(result.cleanupConfirmed,true);assert.equal(result.inputsUnchanged,true);assert.equal(result.liveBaselineUnchanged,true)
  assert.deepEqual(result.phases.map(p=>p.status),['passed','passed','passed'])
  assert.deepEqual(fake.processOptions.map(o=>o.runner),[inputs.old.runner,inputs.candidate.runner,inputs.old.runner])
  assert.deepEqual(fake.processOptions.map(o=>o.profile),[inputs.old.profile,inputs.candidate.profile,inputs.old.profile])
  assert.equal(new Set(fake.processOptions.map(o=>o.dataRoot)).size,1)
  assert.equal(new Set(fake.clientOptions.map(o=>o.dataRoot)).size,1)
  assert.equal(new Set(fake.clientOptions.map(o=>o.username)).size,1)
  assert.equal(new Set(fake.clientOptions.map(o=>o.password)).size,1)
  assert.deepEqual(fake.authArguments,[{version:inputs.old.version,spaceId:undefined},{version:inputs.candidate.version,spaceId:'sp_owned'},{version:inputs.old.version,spaceId:'sp_owned'}])
  assert.equal(result.productionDataAccessed,false);assert.equal(result.productionConfigAccessed,false);assert.equal(result.servicesChanged,false)
  assert.equal(result.productionAcceptance,'not_run')
  const config=JSON.parse(await readFile(join(work,'collaboration.json'),'utf8'))
  assert.equal(config.dataPath,join(work,'data'));assert.equal(config.bootstrapPasswordEnv,'PKW_COMPAT_BOOTSTRAP')
  const credentials=JSON.parse(await readFile(join(work,'synthetic-credentials.json'),'utf8'))
  assert.equal(credentials.password,fake.clientOptions[0].password)
  assert.equal((await stat(join(work,'synthetic-credentials.json'))).mode&0o777,0o600)
  assert.ok(!JSON.stringify(result).includes(credentials.password),'report must not contain generated credentials')
})

test('legacy scenario start failure always cleans up and never authenticates or starts another writer',async t=>{
  const {work}=await scene(t),fake=stubs({startFailure:0})
  let failure
  await assert.rejects(checkLegacyCompatibility({workDir:work},fake.dependencies),error=>{failure=error;return error.code==='PKW_TEST_START_FAILED'})
  assert.deepEqual(fake.events,['start:old-1','stop:old-1']);assert.equal(fake.clientOptions.length,0)
  assert.equal(failure.report.status,'LEGACY_COMPATIBILITY_STOPPED');assert.equal(failure.report.phases[0].error.code,'PKW_TEST_START_FAILED')
  assert.equal(failure.report.phases[0].stop.cleanupConfirmed,true);assert.equal(failure.report.sceneRetained,true)
  assert.equal(JSON.parse(await readFile(failure.reportPath,'utf8')).status,'LEGACY_COMPATIBILITY_STOPPED')
})

test('legacy scenario an unclean native stop never advances even if process cleanup is confirmed',async t=>{
  const {work}=await scene(t),fake=stubs({stopFailure:0})
  let failure
  await assert.rejects(checkLegacyCompatibility({workDir:work},fake.dependencies),error=>{failure=error;return error.code==='PKW_LEGACY_STOP_UNCONFIRMED'})
  assert.deepEqual(fake.events,expectedEvents.slice(0,4));assert.equal(fake.processOptions.length,1)
  assert.equal(failure.report.phases[0].status,'failed');assert.equal(failure.report.phases[0].stop.ok,false)
  assert.equal(failure.report.cleanupConfirmed,true,'cleaned up is distinct from a graceful compatibility pass')
})

test('legacy scenario cleanup exception preserves startup error and explicitly refuses cleanup success',async t=>{
  const {work}=await scene(t),fake=stubs({startFailure:0,stopThrows:0})
  let failure
  await assert.rejects(checkLegacyCompatibility({workDir:work},fake.dependencies),error=>{failure=error;return error.code==='PKW_TEST_START_FAILED'})
  assert.equal(failure.report.phases[0].stop.error.code,'PKW_TEST_STOP_THREW')
  assert.equal(failure.report.cleanupConfirmed,false);assert.deepEqual(fake.events,['start:old-1','stop:old-1'])
})

test('legacy scenario late abort during final cleanup cannot produce an overall pass',async t=>{
  const {work}=await scene(t),controller=new AbortController()
  const fake=stubs({onStop:index=>{if(index===2)controller.abort()}})
  let failure
  await assert.rejects(checkLegacyCompatibility({workDir:work,signal:controller.signal},fake.dependencies),error=>{failure=error;return error.code==='PKW_LEGACY_INTERRUPTED'})
  assert.deepEqual(fake.events,expectedEvents)
  assert.equal(failure.report.status,'LEGACY_COMPATIBILITY_STOPPED');assert.equal(failure.report.cleanupConfirmed,true)
  assert.equal(failure.report.error.code,'PKW_LEGACY_INTERRUPTED')
})

test('legacy scenario refuses an existing directory or symlink before inspecting anything',async t=>{
  for(const type of ['directory','symlink']) {
    const {parent,work}=await scene(t),target=join(parent,'existing')
    await mkdir(target);await writeFile(join(target,'precious.txt'),'unchanged')
    if(type==='directory')await mkdir(work);else await symlink(target,work)
    let observed=0,inspected=0
    const fake=stubs({observe:async()=>{observed++;return baseline},inspect:async()=>{inspected++;return inputs}})
    await assert.rejects(checkLegacyCompatibility({workDir:work},fake.dependencies),{code:'PKW_LEGACY_WORK_EXISTS'})
    assert.equal(observed,0);assert.equal(inspected,0);assert.deepEqual(fake.events,[])
    assert.equal(await readFile(join(target,'precious.txt'),'utf8'),'unchanged')
  }
})

test('legacy scenario failed live baseline or artifact inspection never creates a work scene',async t=>{
  for(const stage of ['observe','inspect']) {
    const {work}=await scene(t),fake=stubs({[stage]:async()=>{throw fault('PKW_TEST_BASELINE_FAILED')}})
    await assert.rejects(checkLegacyCompatibility({workDir:work},fake.dependencies),{code:'PKW_TEST_BASELINE_FAILED'})
    await assert.rejects(stat(work),{code:'ENOENT'});assert.deepEqual(fake.events,[])
  }
})

test('legacy scenario final live or code drift fails after cleanup and retains exact evidence',async t=>{
  for(const stage of ['observe','inspect']) {
    const {work}=await scene(t)
    let calls=0
    const original=stage==='observe'?baseline:inputs
    const fake=stubs({[stage]:async()=>++calls===1?structuredClone(original):{...structuredClone(original),changed:true}})
    let failure
    await assert.rejects(checkLegacyCompatibility({workDir:work},fake.dependencies),error=>{failure=error;return error.code==='PKW_LEGACY_DRIFT'})
    assert.deepEqual(fake.events,expectedEvents);assert.equal(calls,2)
    assert.equal(failure.report.cleanupConfirmed,true);assert.equal(failure.report.status,'LEGACY_COMPATIBILITY_STOPPED')
    assert.equal(failure.report.finalCheckError.code,'PKW_LEGACY_DRIFT')
    assert.equal(failure.report[stage==='observe'?'liveBaselineUnchanged':'inputsUnchanged'],false)
  }
})

test('legacy scenario direct orchestration preserves failure evidence before stopping after candidate readback failure',async()=>{
  const fake=stubs(),report={phases:[]}
  const factory=fake.dependencies.clientFactory
  fake.dependencies.clientFactory=options=>{
    const client=factory(options)
    if(fake.clientOptions.length===2)client.verifyFixture=async()=>{fake.events.push('read:new:failed');throw fault('PKW_TEST_READBACK_FAILED')}
    return client
  }
  await assert.rejects(runCompatibilityScenario({inputs,work:'/synthetic',dataRoot:'/synthetic/data',config:'/synthetic/config',port:43123,username:'owner',password:'private',report},fake.dependencies),{code:'PKW_TEST_READBACK_FAILED'})
  assert.deepEqual(fake.events,[...expectedEvents.slice(0,6),'read:new:failed','stop:new'])
  assert.equal(report.phases.length,2);assert.equal(report.phases[1].status,'failed')
  assert.equal(report.phases[1].error.code,'PKW_TEST_READBACK_FAILED');assert.equal(report.phases[1].stop.cleanupConfirmed,true)
})
