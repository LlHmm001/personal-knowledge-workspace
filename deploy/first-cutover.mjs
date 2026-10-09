#!/usr/bin/env node
/** Prepare a reviewable plan; activate/rollback require its exact digest and maintenance flag. */
import { execFile } from 'node:child_process'
import { createHash,randomUUID } from 'node:crypto'
import { lstat,mkdir,open,readFile,readdir,realpath,statfs,unlink } from 'node:fs/promises'
import { dirname,join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs,promisify } from 'node:util'
import { SITE,inspectCompatibilityInputs,observeLiveBaseline } from './check-legacy-compatibility.mjs'
import { snapshotTree } from './prepare-first-cutover.mjs'
import { createFirstCutoverService,FIRST_CUTOVER_CONFIG } from './site/first-cutover-systemd.mjs'
import { captureFirstCutoverBaseline,verifyFirstCutoverBaseline,checkFirstCutoverCredentials } from './site/first-cutover-acceptance.mjs'
import { coldBackupForFirstCutover } from './site/first-cutover-backup.mjs'
import { firstCutoverTransaction,assertFirstAcceptance,errorRecord } from './site/first-cutover-transaction.mjs'
import { sha256,exists,readPrivateFile,writePrivateJson,independentDropIn,ownedReferences,installOwnedReferences,removeOwnedReferences } from './site/first-cutover-files.mjs'
import { processIdentity,prepareRootLock } from '../scripts/root-lock.mjs'
const exec=promisify(execFile)
const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const NODE='/root/.hermes/node/bin/node',UNIT='pkw-collaboration.service',DATA='/root/.dsh/pkw-collab'
const ENV='/root/pkw-upgrade-2026-10-02/secrets/pkw-gateway.env',UNITFILE='/etc/systemd/system/pkw-collaboration.service'
const COMPAT='/LlHmm9527/pkw-legacy-compat-Z73xiQ/run/compatibility-report.json'
const CURRENT=join(SITE.prepared,'current'),TARGET='releases/0.1.9-pkw.1',DROPIN='/etc/systemd/system/pkw-collaboration.service.d/50-pkw-independent.conf'
const REF={current:CURRENT,target:TARGET,dropIn:DROPIN,content:independentDropIn({node:NODE,current:CURRENT,config:FIRST_CUTOVER_CONFIG})}
const fail=(code,message)=>Object.assign(new Error(message),{code:`PKW_FIRST_${code}`})
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const unitEnvironment={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LC_ALL:'C',LANG:'C'}
async function command(executable,args,timeout=5000){try{return await exec(executable,args,{timeout,killSignal:'SIGKILL',maxBuffer:65536,env:unitEnvironment})}catch(error){throw fail('COMMAND',`Bounded ${executable} operation failed (${error.code??error.signal??'unknown'})`)}}
async function dshUnchanged(){
 const {stdout}=await command('/usr/bin/systemctl',['show','deepseek-harness.service','--property=MainPID','--property=NRestarts','--property=ActiveState','--property=SubState','--property=ControlPID'])
 const values=Object.fromEntries(stdout.trim().split('\n').map(x=>x.split('=')))
 const stat=await readFile('/proc/1585972/stat','utf8')
 if(values.MainPID!=='1585972'||values.NRestarts!=='0'||values.ActiveState!=='active'||values.SubState!=='running'||values.ControlPID!=='0'||stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19]!=='851055080'||sha256(await readFile('/proc/1585972/cmdline'))!=='1242c76bf0cebfd964a79b3769677be7957fadd6896cac88f7704987c75d3d3d')throw fail('DSH_CHANGED','DSH process identity or restart count changed')
 return{ok:true,pid:1585972,NRestarts:0,state:'active/running'}
}
function service(){return createFirstCutoverService({unit:UNIT,dataRoot:DATA,port:3081,node:NODE,config:FIRST_CUTOVER_CONFIG,old:{runner:SITE.oldRunner,profile:SITE.oldProfile,version:SITE.oldVersion},candidate:{runner:join(CURRENT,'runner/scripts/serve-collaboration.mjs'),profile:join(CURRENT,'profile'),version:SITE.newVersion}})}
async function requireProof(svc,version){const proof=await svc.inspectRunning(version);if(proof.ok!==true)throw Object.assign(fail('INSTANCE','The configured PKW process does not own the expected code/data lock/loopback listener'),{evidence:proof});return proof}
async function codeUnchanged(inputs){
 if(sha256(await readPrivateFile(SITE.oldRunner))!==SITE.oldRunnerSha256||sha256(await readPrivateFile(join(SITE.oldProfile,'package.json')))!==SITE.oldManifestSha256)throw fail('LEGACY_CHANGED','Legacy code/manifest changed')
 for(const pkg of inputs.old.packages){const t=await snapshotTree(join(pkg.directory,'lib'));if(t.sha256!==pkg.libSha256||t.identitySha256!==pkg.identitySha256||sha256(await readPrivateFile(join(pkg.directory,'package.json')))!==pkg.manifestSha256)throw fail('LEGACY_CHANGED','Installed legacy package bytes or identity changed')}
 const profile=await snapshotTree(inputs.candidate.profile),runner=await snapshotTree(dirname(dirname(inputs.candidate.runner)))
 if(profile.sha256!==SITE.profileSha256||runner.sha256!==SITE.runnerSha256||profile.identitySha256!==inputs.candidate.profileIdentitySha256||runner.identitySha256!==inputs.candidate.runnerIdentitySha256)throw fail('CANDIDATE_CHANGED','Prepared candidate bytes or identity changed')
 return{ok:true}
}
async function referenceFiles(){
 const result={}
 for(const path of [UNITFILE,FIRST_CUTOVER_CONFIG,ENV]){const bytes=await readPrivateFile(path,{...(path===ENV?{mode:0o600}:{})});result[path]=sha256(bytes)}
 if(result[UNITFILE]!=='4fdf72f6c4e12e27d736d0331fcdd9dcecbc86e58f158e74f9ab7b6bb270f6a1'||result[FIRST_CUTOVER_CONFIG]!=='26fedc373da3637817af19acfbd623068f5d1bbfb3b0ab401140828045807266')throw fail('BASELINE_CHANGED','Original unit or configuration changed')
 const config=JSON.parse(await readPrivateFile(FIRST_CUTOVER_CONFIG));if(config.dataPath!==DATA||config.publicOrigin!=='https://ddmind.duckdns.org'||await realpath(DATA)!==DATA)throw fail('DATA_ROOT','Original configuration no longer names the canonical production data/origin')
 const ds=await lstat(DATA);if(!ds.isDirectory()||ds.uid!==0||(ds.mode&0o7777)!==0o700||await exists(join(DATA,'recovery-pending.json')))throw fail('DATA_STATE','Canonical data permissions or recovery state changed')
 for(const name of ['identity.sqlite','spaces'])if(!await exists(join(DATA,name)))throw fail('DATA_STATE','Existing identity/space data is required; bootstrap is forbidden')
 return result
}
async function checkDropInSet(allowOwned){
 const dir=dirname(DROPIN);if(!await exists(dir))return
 if(await realpath(dir)!==dir)throw fail('DROPIN_PARENT','Unit drop-in directory is not canonical')
 const entries=await readdir(dir);if(entries.some(name=>name.endsWith('.conf')&&(!allowOwned||name!=='50-pkw-independent.conf')))throw fail('EXTRA_DROPIN','Another unit drop-in appeared; it is retained')
}
async function budget(){const {stdout}=await command('/usr/bin/du',['-sk','--',DATA],10000);const bytes=Number(stdout.trim().split(/\s+/)[0])*1024;if(!Number.isSafeInteger(bytes)||bytes<1)throw fail('SPACE','Cannot establish data size');const disk=await statfs('/LlHmm9527'),system=await statfs('/');const required=Math.max(512*1024*1024,bytes*4+64*1024*1024);if(disk.bavail*disk.bsize<required||system.bavail*system.bsize<256*1024*1024)throw fail('SPACE','Insufficient verified backup/system capacity');return{dataAllocatedBytes:bytes,dataDiskAvailable:disk.bavail*disk.bsize,systemAvailable:system.bavail*system.bsize,requiredDataDiskBytes:required}}
export function validateCompatibility(value,inputs){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.status!=='LEGACY_SYNTHETIC_COMPATIBILITY_PASSED'||value.sourceSha!=='b634a58a7953b039dc4ca662eb19eca3363c1ebd'||value.syntheticOnly!==true||value.cleanupConfirmed!==true||value.liveBaselineUnchanged!==true||value.inputsUnchanged!==true||!same(value.inputs,inputs)||!Array.isArray(value.phases)||value.phases.length!==3)throw fail('COMPATIBILITY','Returned actual-legacy compatibility evidence is missing or changed')
 for(let i=0;i<3;i++){const p=value.phases[i];if(!p||p.name!==['legacy-write','candidate-read-write','legacy-read-back'][i]||p.status!=='passed'||p.version!==(i===1?SITE.newVersion:SITE.oldVersion)||p.stop?.ok!==true||p.stop?.cleanupConfirmed!==true||p.auth?.authenticated!==true)throw fail('COMPATIBILITY','Every compatibility phase must have authenticated business and native-cleanup evidence')}
 if(value.phases[1].oldRead?.ok!==true||value.phases[2].oldRead?.ok!==true||value.phases[2].newRead?.ok!==true)throw fail('COMPATIBILITY','Cross-version body and attachment readbacks are required')
}
async function prepare({workDir,credentialsFile,sourceSha,signal}){
 const work=resolve(workDir??''),credentials=resolve(credentialsFile??'')
 if(!/^\/LlHmm9527\/pkw-first-cutover-[A-Za-z0-9]+\/plan$/.test(work)||credentials!==join(dirname(work),'credentials.json')||await realpath(dirname(work))!==dirname(work)||await exists(work))throw fail('WORK','Use a new prepare-plan handoff directory; scenes are never reused')
 if(signal.aborted)throw fail('INTERRUPTED','Preparation interrupted')
 await checkFirstCutoverCredentials(credentials)
 const live=await observeLiveBaseline(),inputs=await inspectCompatibilityInputs(),compatBytes=await readPrivateFile(COMPAT)
 validateCompatibility(JSON.parse(compatBytes),inputs);await checkDropInSet(false);await ownedReferences(REF,'absent')
 const files=await referenceFiles(),space=await budget(),svc=service(),legacyProof=await requireProof(svc,SITE.oldVersion)
 const acceptance=await captureFirstCutoverBaseline({credentialsFile:credentials,expectedVersion:SITE.oldVersion,confirmInstance:()=>requireProof(svc,SITE.oldVersion),signal})
 assertFirstAcceptance(acceptance,SITE.oldVersion,true)
 await dshUnchanged();await observeLiveBaseline();await codeUnchanged(inputs)
 if(!same(files,await referenceFiles())||signal.aborted)throw fail('PREPARE_CHANGED','Preparation inputs changed or were interrupted')
 const tools=await snapshotTree(sourceRoot)
 await mkdir(work,{mode:0o700})
 const plan={format:'pkw-first-cutover-plan-v1',status:'FIRST_CUTOVER_PLAN_READY',work,sourceRoot,sourceSha,toolsSha256:tools.sha256,createdAt:new Date().toISOString(),credentialsFile:credentials,credentialsSha256:sha256(await readPrivateFile(credentials,{mode:0o600})),inputs,compatibility:{path:COMPAT,sha256:sha256(compatBytes)},files,space,live,legacyProof,acceptance,reference:REF,servicesChanged:false,productionAcceptance:'not_run',dataRoot:DATA,unit:UNIT}
 await writePrivateJson(join(work,'plan.json'),plan,{exclusive:true});await writePrivateJson(join(work,'unit-change.json'),{dropIn:DROPIN,contents:REF.content,originalUnitPreserved:true,configAndEnvironmentReferencesPreserved:true},{exclusive:true})
 const planSha256=sha256(await readPrivateFile(join(work,'plan.json')))
 return{status:plan.status,plan:join(work,'plan.json'),planSha256,sourceSha:plan.sourceSha,space,legacyReadAcceptance:true,authSessionCreated:true,businessWrites:false,servicesChanged:false,maintenanceRequired:true,activationCommand:[NODE,join(sourceRoot,'deploy/first-cutover.mjs'),'activate','--plan',join(work,'plan.json'),'--plan-sha256',planSha256,'--maintenance-approved'],rollbackCommand:[NODE,join(sourceRoot,'deploy/first-cutover.mjs'),'rollback','--plan',join(work,'plan.json'),'--plan-sha256',planSha256,'--maintenance-approved']}
}
async function executorLock(work,action){
 const path=join(work,'gateway.lock')
 if(await exists(path))await readPrivateFile(path,{mode:0o600,max:16384})
 const gate=await prepareRootLock(work);if(!gate.ready)throw fail('EXECUTOR_BUSY','Another cutover executor may be alive; its private lock is preserved')
 const h=await open(path,'wx',0o600),body=JSON.stringify({pid:process.pid,identity:await processIdentity(),createdAt:new Date().toISOString(),operation:'first-cutover'})+'\n'
 try{await h.writeFile(body);await h.sync();return await action()}finally{const held=await h.stat();await h.close();const current=await lstat(path);if(current.ino!==held.ino||sha256(await readPrivateFile(path,{mode:0o600,max:16384}))!==sha256(body))throw fail('EXECUTOR_CHANGED','Private executor lock changed; it was not removed');await unlink(path)}
}
async function execute({planPath,expectedSha,approved,rollbackOnly,signal}){
 if(!approved||!/^\/[A-Za-z0-9_./-]+\/plan\/plan.json$/.test(planPath??'')||!/^[a-f0-9]{64}$/.test(expectedSha??''))throw fail('MAINTENANCE_REQUIRED','Exact plan digest and explicit --maintenance-approved are required')
 const bytes=await readPrivateFile(resolve(planPath),{mode:0o600});if(sha256(bytes)!==expectedSha)throw fail('PLAN_CHANGED','The approved plan digest does not match')
 const plan=JSON.parse(bytes),work=dirname(resolve(planPath))
 if(plan.format!=='pkw-first-cutover-plan-v1'||plan.work!==work||!/^\/LlHmm9527\/pkw-first-cutover-[A-Za-z0-9]+\/plan$/.test(work)||plan.sourceRoot!==sourceRoot||plan.dataRoot!==DATA||plan.unit!==UNIT||!same(plan.reference,REF)||plan.credentialsFile!==join(dirname(work),'credentials.json'))throw fail('PLAN_SCOPE','Plan paths or reference delta differ from the reviewed first conversion')
 return executorLock(work,async()=>{
 const journalPath=join(work,rollbackOnly?`rollback-${randomUUID()}.json`:'activation.json')
 if(!rollbackOnly&&await exists(journalPath))throw fail('ALREADY_ATTEMPTED','A cutover was already attempted; preserve its journal, do not restart the transaction')
 if(rollbackOnly){const previous=JSON.parse(await readPrivateFile(join(work,'activation.json'),{mode:0o600}));if(previous.status!=='ACTIVATED_VERIFIED')throw fail('ROLLBACK_STATE','Manual rollback requires a previously verified activation; interrupted scenes require separate inspection')}
 const report={status:'created',planSha256:expectedSha,sourceSha:plan.sourceSha,work,mode:rollbackOnly?'rollback':'activate',dataRoot:DATA,databaseRestored:false,actions:[]}
 const save=async()=>{await writePrivateJson(journalPath,report);console.log(JSON.stringify({phase:report.actions.at(-1)?.action??report.status,state:report.actions.at(-1)?.state??report.status,evidence:journalPath}))}
 await writePrivateJson(journalPath,report,{exclusive:true})
 const svc=service() // A single adapter retains every observed old/partial-candidate PID through recovery.
 const requireStop=async()=>{const e=await svc.probeStopped();if(!e.known||!e.stopped)throw Object.assign(fail('STOP_UNCONFIRMED','Writer, cgroup, port or data lock remains unconfirmed'),{evidence:e});return e}
 const checkFiles=async({checkDsh=true}={})=>{if(!same(plan.files,await referenceFiles()))throw fail('CONFIG_CHANGED','Original unit/config/environment bytes changed');await checkDropInSet(true);await codeUnchanged(plan.inputs);if(checkDsh)await dshUnchanged()}
 const hooks={
  preflight:async mode=>{
   if((await snapshotTree(sourceRoot)).sha256!==plan.toolsSha256||sha256(await readPrivateFile(COMPAT))!==plan.compatibility.sha256||sha256(await readPrivateFile(plan.credentialsFile,{mode:0o600}))!==plan.credentialsSha256)throw fail('PLAN_INPUT_CHANGED','Reviewed tools, compatibility evidence or acceptance credentials changed')
   await checkFiles();await ownedReferences(REF,mode==='activate'?'absent':'owned');await budget()
   if(mode==='activate')await observeLiveBaseline()
   return requireProof(svc,mode==='activate'?SITE.oldVersion:SITE.newVersion)
  },
  capture:version=>captureFirstCutoverBaseline({credentialsFile:plan.credentialsFile,expectedVersion:version,confirmInstance:()=>requireProof(svc,version),signal}),
  probeStopped:()=>svc.probeStopped(),stop:()=>svc.stopAndConfirm(),
  backup:()=>coldBackupForFirstCutover({dataRoot:DATA,output:join(work,'cold-backup'),work:join(work,'backup-worker'),toolRoot:dirname(dirname(plan.inputs.candidate.runner)),node:NODE,signal},{confirmStopped:requireStop}),
  install:async()=>{await requireStop();await checkFiles();const r=await installOwnedReferences(REF,{checkpoint:requireStop});await command('/usr/bin/systemctl',['daemon-reload']);return r},
  restore:async()=>{await requireStop();await checkFiles({checkDsh:false});const r=await removeOwnedReferences(REF,{checkpoint:requireStop});await command('/usr/bin/systemctl',['daemon-reload']);return r},
  start:version=>svc.start(version),
  verify:(baseline,version,mode)=>verifyFirstCutoverBaseline({credentialsFile:plan.credentialsFile,expectedVersion:version,baseline,mode,confirmInstance:()=>requireProof(svc,version)}),
  checkDsh:dshUnchanged,
 }
 try{await firstCutoverTransaction({hooks,report,save,signal,rollbackOnly})}catch(error){throw Object.assign(error,{evidence:journalPath})}
 return{status:report.status,evidence:journalPath,databaseRestored:false,backup:report.backup?.backupRoot??null,backupManifestSha256:report.backup?.manifestSha256??null,productionReadAcceptance:'verified',userBusinessConfirmation:'pending',dshUnchanged:true}
 })
}
/** Parse all mode boundaries before invoking a handler that can read credentials or touch a service. */
export function parseFirstCutoverArguments(args,{sourceSha}={}){
 const {values,positionals,tokens}=parseArgs({args,allowPositionals:true,tokens:true,options:{'work-dir':{type:'string'},'credentials-file':{type:'string'},plan:{type:'string'},'plan-sha256':{type:'string'},'maintenance-approved':{type:'boolean'}}})
 if(positionals.length!==1||!['prepare','activate','rollback'].includes(positionals[0]))throw fail('USAGE','Use prepare, activate or rollback with explicit plan arguments')
 const seen=new Set()
 for(const token of tokens){if(token.kind!=='option')continue;if(seen.has(token.name))throw fail('USAGE','Repeated arguments are not accepted');seen.add(token.name)}
 const mode=positionals[0]
 if(mode==='prepare'){
  if(['plan','plan-sha256','maintenance-approved'].some(key=>Object.hasOwn(values,key)))throw fail('USAGE','Prepare accepts only --work-dir and --credentials-file; it cannot activate')
  if(!/^[a-f0-9]{40}$/.test(sourceSha??''))throw fail('SOURCE_SHA','Prepare requires the complete source SHA supplied by the reviewed handoff')
  const work=values['work-dir'],credentials=values['credentials-file']
  if(!/^\/LlHmm9527\/pkw-first-cutover-[A-Za-z0-9]+\/plan$/.test(work??'')||credentials!==join(dirname(work),'credentials.json'))throw fail('WORK','Use the exact new prepare-plan work and credential paths')
  return {mode,options:{workDir:work,credentialsFile:credentials,sourceSha}}
 }
 if(['work-dir','credentials-file'].some(key=>Object.hasOwn(values,key)))throw fail('USAGE','Activation and rollback accept a reviewed plan, not preparation paths')
 if(values['maintenance-approved']!==true||!/^\/LlHmm9527\/pkw-first-cutover-[A-Za-z0-9]+\/plan\/plan\.json$/.test(values.plan??'')||!/^[a-f0-9]{64}$/.test(values['plan-sha256']??''))throw fail('MAINTENANCE_REQUIRED','Exact plan path, digest and explicit --maintenance-approved are required')
 return {mode,options:{planPath:values.plan,expectedSha:values['plan-sha256'],approved:true,rollbackOnly:mode==='rollback'}}
}

// Narrow handler injection permits checking the public mode boundary without a live unit or credentials.
// The executable always uses the real handlers below; injection is not exposed through flags or environment.
export async function dispatchFirstCutover(args,{sourceSha,signal}={},handlers={prepare,execute}){
 const parsed=parseFirstCutoverArguments(args,{sourceSha})
 if(signal?.aborted)throw fail('INTERRUPTED','Interrupted before any first-cutover action')
 return parsed.mode==='prepare'?handlers.prepare({...parsed.options,signal}):handlers.execute({...parsed.options,signal})
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const controller=new AbortController(),interrupt=()=>controller.abort();process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt)
 const timer=setTimeout(interrupt,12*60*1000)
 try{
  if(process.platform!=='linux'||process.getuid?.()!==0||process.version!=='v22.23.1'||process.execPath!==NODE)throw fail('PLATFORM','The recorded Linux/root Node 22.23.1 runtime is required')
  const result=await dispatchFirstCutover(process.argv.slice(2),{sourceSha:process.env.PKW_FIRST_CUTOVER_SOURCE_SHA,signal:controller.signal})
  console.log(JSON.stringify(result))
 }catch(error){console.log(JSON.stringify({status:error.report?.status??'FIRST_CUTOVER_STOPPED',error:errorRecord(error),originalError:error.report?.error??null,recoveryError:error.report?.recoveryError??null,evidence:error.evidence??error.reportPath??null,databaseRestored:false}));process.exitCode=1}
 finally{clearTimeout(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt)}
}
