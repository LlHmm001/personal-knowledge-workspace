import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { coldBackupForFirstCutover } from '../../deploy/site/first-cutover-backup.mjs'
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(t,{tools=false}={}) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'pkw-first-backup-')))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const dataRoot=join(root,'data'),output=join(root,'backup'),work=join(root,'worker'),toolRoot=tools?join(root,'tools'):await realpath(repo)
  await mkdir(dataRoot,{mode:0o700})
  if(tools){await mkdir(join(toolRoot,'scripts'),{recursive:true});await writeFile(join(toolRoot,'scripts/collaboration-backup.mjs'),'// test tool');await writeFile(join(toolRoot,'scripts/data-preservation.mjs'),'// test preservation')}
  return {root,dataRoot,output,work,toolRoot,timeoutMs:10000,graceMs:100}
}
function identityFixture(dataRoot) {
  const db=new DatabaseSync(join(dataRoot,'identity.sqlite'))
  db.exec(`PRAGMA user_version=1;
CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL);
CREATE TABLE spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,ownerId TEXT NOT NULL REFERENCES accounts(id));
CREATE TABLE members(spaceId TEXT NOT NULL REFERENCES spaces(id),userId TEXT NOT NULL REFERENCES accounts(id),role TEXT NOT NULL,PRIMARY KEY(spaceId,userId));
CREATE TABLE invitations(hash TEXT PRIMARY KEY,spaceId TEXT,role TEXT,createdBy TEXT,expires INTEGER);
CREATE TABLE sessions(hash TEXT PRIMARY KEY,userId TEXT,csrf TEXT,expires INTEGER,seen INTEGER);
CREATE TABLE audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER,actor TEXT,spaceId TEXT,action TEXT,subject TEXT);
INSERT INTO accounts VALUES('owner','private-owner','private-retained-hash');
INSERT INTO spaces VALUES('sp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','Unopened','private','owner');
INSERT INTO members VALUES('sp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','owner','owner');
INSERT INTO sessions VALUES('private-session','owner','private-csrf',9999999999999,1);`)
  db.close()
}
function injected(f,modify=()=>{}) {
  let manifestSha256
  const calls=[],stopCalls=[]
  const confirmStopped=async stage=>{stopCalls.push(stage);return {known:true,stopped:true,stage}}
  const runCommand=async (node,args,options)=>{
    const command=args[2],value=JSON.parse(args[3]);calls.push({node,args,options,command,value})
    if(command==='backup') {
      const manifest={format:'pkw-collaboration-backup',version:1,status:'complete',sourceRoot:f.dataRoot,offlineConfirmed:true,sourceInventory:{fingerprint:'a'.repeat(64)},payload:[],databases:[]}
      await mkdir(f.output,{mode:0o700});await writeFile(join(f.output,'manifest.json'),JSON.stringify(manifest),{mode:0o600})
      manifestSha256=digest(await readFile(join(f.output,'manifest.json')))
    }
    const summary={ok:true,operation:command,backup:f.output,manifestSha256,sourceFingerprint:'a'.repeat(64),byteIntegrity:'passed',sqliteIntegrity:'passed',ready:true,sourceUnchanged:true,keepWritersStopped:true}
    const result={code:0,signal:null,error:null,interrupted:false,timedOut:false,stdout:JSON.stringify(summary),tail:'private',groupCleanup:{known:true,present:false,closed:true,confirmed:true}}
    await modify({command,value,summary,result,options,calls})
    return result
  }
  return {confirmStopped,runCommand,calls,stopCalls}
}

test('first cold backup runs the actual built-in preservation tool, verifies manifest/source, and changes no database bytes',async t=>{
  const f=await fixture(t);identityFixture(f.dataRoot)
  const before=await readFile(join(f.dataRoot,'identity.sqlite'))
  const stopCalls=[]
  const result=await coldBackupForFirstCutover(f,{confirmStopped:async stage=>{stopCalls.push(stage);return {known:true,stopped:true}}})
  assert.equal(result.ok,true);assert.equal(result.sourceVerified,true);assert.equal(result.cleanupConfirmed,true)
  assert.deepEqual(result.runs.map(run=>run.operation),['backup','verify','verify-source'])
  assert.deepEqual(stopCalls,['before-backup-work','before-backup','before-verify','before-verify-source','after-backup'])
  assert.equal(result.manifestSha256,digest(await readFile(join(f.output,'manifest.json'))))
  assert.deepEqual(await readFile(join(f.dataRoot,'identity.sqlite')),before)
  await assert.rejects(stat(join(f.dataRoot,'gateway.lock')),{code:'ENOENT'})
  assert.equal((await stat(f.output)).mode&0o777,0o700)
  assert.ok(!JSON.stringify(result).includes('private-owner'));assert.ok(!JSON.stringify(result).includes('private-retained-hash'))
  for(const run of result.runs){assert.equal(run.execution.code,0);assert.equal(run.execution.groupCleanup.confirmed,true);assert.equal(run.lockAbsent,true)}
})

test('first cold backup refuses missing or uncertain stop evidence before creating anything',async t=>{
  for(const state of [null,{known:false,stopped:false},{known:true,stopped:false}]) {
    const f=await fixture(t,{tools:true});let ran=0
    await assert.rejects(coldBackupForFirstCutover(f,{confirmStopped:async()=>state,runCommand:async()=>{ran++}}),{code:'PKW_FIRST_BACKUP_STOP_UNCONFIRMED'})
    assert.equal(ran,0);await assert.rejects(stat(f.work),{code:'ENOENT'});await assert.rejects(stat(f.output),{code:'ENOENT'})
  }
  const f=await fixture(t,{tools:true})
  await assert.rejects(coldBackupForFirstCutover(f),{code:'PKW_FIRST_BACKUP_STOP_REQUIRED'})
})

test('first cold backup refuses an existing root lock unchanged without invoking the backup tool',async t=>{
  const f=await fixture(t,{tools:true});await writeFile(join(f.dataRoot,'gateway.lock'),'precious-owner')
  const fake=injected(f)
  await assert.rejects(coldBackupForFirstCutover(f,fake),{code:'PKW_FIRST_BACKUP_LOCK_PRESENT'})
  assert.equal(fake.calls.length,0);assert.equal(await readFile(join(f.dataRoot,'gateway.lock'),'utf8'),'precious-owner')
})

test('first cold backup supplies only a private environment and binds each verification to the captured digest',async t=>{
  const f=await fixture(t,{tools:true}),fake=injected(f)
  const result=await coldBackupForFirstCutover(f,fake)
  assert.equal(result.ok,true)
  for(const call of fake.calls){assert.equal(call.options.env.HOME,join(f.work,'home'));assert.equal(call.options.env.NODE_OPTIONS,undefined);assert.equal(call.options.env.NODE_PATH,undefined);assert.equal(call.options.env.WEKNORA_API_KEY,undefined)}
  assert.equal(fake.calls[1].value.manifestSha256,result.manifestSha256);assert.equal(fake.calls[2].value.manifestSha256,result.manifestSha256)
  assert.equal(fake.calls[1].value.requireReady,true);assert.equal(fake.calls[2].value.offlineConfirmed,true)
})

test('first cold backup native nonzero, deadline, missing group cleanup or signal cannot be hidden by success JSON',async t=>{
  for(const change of [{code:1},{timedOut:true},{signal:'SIGTERM'},{groupCleanup:{confirmed:false}}]) {
    const f=await fixture(t,{tools:true}),fake=injected(f,({result})=>Object.assign(result,change))
    let failure
    await assert.rejects(coldBackupForFirstCutover(f,fake),error=>{failure=error;return error.code==='PKW_FIRST_BACKUP_WORKER_FAILED'})
    assert.equal(fake.calls.length,1);assert.equal(failure.report.ok,false);assert.equal(failure.report.sourceVerified,false)
    assert.equal((await stat(f.output)).isDirectory(),true)
  }
})

test('first cold backup incomplete command execution cannot claim cleanup evidence',async t=>{
  const f=await fixture(t,{tools:true}),fake=injected(f)
  fake.runCommand=async()=>{throw Object.assign(new Error('execution failed'),{code:'SYNTHETIC'})}
  let failure
  await assert.rejects(coldBackupForFirstCutover(f,fake),error=>{failure=error;return error.code==='SYNTHETIC'})
  assert.equal(failure.report.cleanupConfirmed,false);assert.equal(failure.report.runs[0].execution.groupCleanup.confirmed,false)
})

test('first cold backup readiness or source mismatch keeps completed backup and refuses activation evidence',async t=>{
  for(const stage of ['verify','verify-source']) {
    const f=await fixture(t,{tools:true}),fake=injected(f,({command,result,summary})=>{
      if(command===stage){if(stage==='verify')summary.ready=false;else summary.sourceUnchanged=false;result.stdout=JSON.stringify(summary)}
    })
    let failure
    await assert.rejects(coldBackupForFirstCutover(f,fake),error=>{failure=error;return /^PKW_FIRST_BACKUP_(VERIFY|SOURCE)$/.test(error.code)})
    assert.equal(failure.report.ok,false);assert.equal(failure.report.sourceVerified,false);assert.equal(failure.report.cleanupConfirmed,true)
    assert.equal((await stat(join(f.output,'manifest.json'))).isFile(),true)
  }
})

test('first cold backup never deletes a lock left by an interrupted tool',async t=>{
  const f=await fixture(t,{tools:true}),fake=injected(f,async({command})=>{if(command==='backup')await writeFile(join(f.dataRoot,'gateway.lock'),'interrupted-maintenance-owner')})
  let failure
  await assert.rejects(coldBackupForFirstCutover(f,fake),error=>{failure=error;return error.code==='PKW_FIRST_BACKUP_WORKER_FAILED'})
  assert.equal(failure.report.cleanupConfirmed,false)
  assert.equal(await readFile(join(f.dataRoot,'gateway.lock'),'utf8'),'interrupted-maintenance-owner')
})

test('first cold backup refuses reused output and final code drift without overwriting evidence',async t=>{
  const existing=await fixture(t,{tools:true});await mkdir(existing.output);await writeFile(join(existing.output,'keep'),'old')
  await assert.rejects(coldBackupForFirstCutover(existing,injected(existing)),{code:'PKW_FIRST_BACKUP_EXISTS'})
  assert.equal(await readFile(join(existing.output,'keep'),'utf8'),'old')
  const f=await fixture(t,{tools:true}),fake=injected(f,async({command})=>{if(command==='verify-source')await writeFile(join(f.toolRoot,'scripts/data-preservation.mjs'),'changed')})
  await assert.rejects(coldBackupForFirstCutover(f,fake),{code:'PKW_FIRST_BACKUP_DRIFT'})
  assert.equal((await stat(join(f.output,'manifest.json'))).isFile(),true)
})
