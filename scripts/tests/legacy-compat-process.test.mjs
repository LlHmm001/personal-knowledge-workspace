import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCompatProcess } from '../../deploy/site/legacy-compat-process.mjs'

const listener = `
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const args=process.argv.slice(2), get=name=>args[args.indexOf(name)+1];
const cfg=JSON.parse(readFileSync(get('--config'),'utf8'));
if (cfg.mode==='early') process.exit(7);
const lock=join(cfg.dataPath,'gateway.lock');
writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
const server=createServer((req,res)=>{res.writeHead(200);res.end('ready')});
server.on('error',()=>{try{unlinkSync(lock)}catch{};process.exitCode=9});
if(cfg.mode==='noise') process.stderr.write('x'.repeat(2*1024*1024));
server.listen(Number(get('--port')),'127.0.0.1');
let stopping=false;
process.on('SIGTERM',()=>{
  if(stopping){if(cfg.mode==='second-signal')process.exit(1);return;}stopping=true;
  unlinkSync(lock);
  if(cfg.mode==='ignore')return;
  const close=()=>{server.close(()=>{process.exitCode=0});server.closeIdleConnections();};
  if(cfg.mode==='second-signal')setTimeout(close,60);else close();
});
`
async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function fixture(t, mode='normal', options={}) {
  const work = await mkdtemp(join(tmpdir(),'pkw-compat-process-'))
  const profile=join(work,'profile'),dataRoot=join(work,'data'),config=join(work,'config.json'),runner=join(work,'listener.mjs')
  await mkdir(profile);await mkdir(dataRoot)
  await writeFile(config,JSON.stringify({dataPath:dataRoot,bootstrapPasswordEnv:'PKW_COMPAT_BOOTSTRAP',mode}),{mode:0o600})
  await writeFile(runner,listener)
  const manager=createCompatProcess({runner,profile,config,dataRoot,work,password:'test-private-password',port:options.port??await freePort(),startupTimeoutMs:2000,stopTimeoutMs:300,killTimeoutMs:150,...options})
  t.after(async()=>{await manager.stop();await rm(work,{recursive:true,force:true})})
  return {manager,work,config,dataRoot,profile,runner}
}

test('legacy compatibility process proves its own bind and lock, then stops natively',async t=>{
  const {manager,dataRoot}=await fixture(t)
  const start=await manager.start()
  assert.equal(start.proof.confirmed,true);assert.equal(start.proof.pid,start.pid);assert.equal(start.health.status,200)
  assert.equal(JSON.parse(await readFile(join(dataRoot, 'gateway.lock'),'utf8')).pid,start.pid)
  const stop=await manager.stop()
  assert.equal(stop.ok,true,JSON.stringify(stop));assert.equal(stop.graceful,true);assert.equal(stop.cleanupConfirmed,true)
  assert.deepEqual(stop.exit,{exitCode:0,signal:null,spawnError:null});assert.equal(stop.group,'gone');assert.equal(stop.lockAbsent,true)
  assert.equal(await manager.stop(),stop)
})

test('legacy compatibility process never health-probes an occupied port when its child exits early',async t=>{
  let requests=0
  const server=createServer((_req,res)=>{requests++;res.end('unrelated')})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const {manager}=await fixture(t,'early',{port:server.address().port})
  await assert.rejects(manager.start(),{code:'PKW_COMPAT_START_FAILED'})
  assert.equal(requests,0)
  const stop=await manager.stop();assert.equal(stop.ok,false);assert.equal(stop.exit.exitCode,7);assert.equal(stop.evidence.observations.port.held,true)
})

test('legacy compatibility forced termination is cleanup evidence, never successful graceful shutdown',async t=>{
  const {manager}=await fixture(t,'ignore')
  await manager.start()
  const stop=await manager.stop()
  assert.equal(stop.ok,false);assert.equal(stop.forced,true);assert.equal(stop.graceful,false)
  assert.equal(stop.cleanupConfirmed,true,JSON.stringify(stop));assert.equal(stop.exit.signal,'SIGKILL');assert.equal(stop.lockAbsent,true)
})

test('legacy compatibility abort stops only its owned process and preserves observed outcome',async t=>{
  const abort=new AbortController(),{manager}=await fixture(t,'normal',{signal:abort.signal})
  await manager.start();abort.abort()
  const stop=await manager.stop()
  assert.equal(stop.cleanupConfirmed,true,JSON.stringify(stop));assert.equal(stop.exit.exitCode,0)
})

test('legacy compatibility stdout and stderr are drained with a bounded private log',async t=>{
  const {manager}=await fixture(t,'noise')
  const start=await manager.start(),stop=await manager.stop()
  assert.equal(stop.ok,true,JSON.stringify(stop))
  const log=await readFile(start.log);assert.equal(log.length,1_048_576)
})

test('legacy compatibility can reopen the same private data root with a new owned manager',async t=>{
  const f=await fixture(t)
  await f.manager.start();assert.equal((await f.manager.stop()).ok,true)
  const next=createCompatProcess({...f,password:'test-private-password',port:f.manager.state().port,startupTimeoutMs:2000,stopTimeoutMs:500,killTimeoutMs:150})
  t.after(()=>next.stop())
  assert.notEqual(next.state().log,f.manager.state().log)
  await next.start();assert.equal((await next.stop()).ok,true)
})


test('legacy compatibility sends one initial SIGTERM, preserving a runner that forces exit on the second',async t=>{
  const {manager}=await fixture(t,'second-signal')
  await manager.start()
  const stop=await manager.stop()
  assert.equal(stop.ok,true,JSON.stringify(stop));assert.equal(stop.exit.exitCode,0);assert.equal(stop.forced,false)
})
