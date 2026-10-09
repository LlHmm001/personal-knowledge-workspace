import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { makeSyntheticDataRoot } from './helpers/synthetic.mjs'
import { runOwned } from '../../deploy/rehearse-matrix.mjs'

// Exercise the real rehearsal CLI, HTTP writer, listener and on-disk byte checks.
// Only the install/switch transaction and gateway implementation are fixtures: the
// gateway deliberately accepts the product upload contract, not the former driver.
async function runWriter(t, reply) {
  const root = await mkdtemp(join(tmpdir(), 'pkw-rehearsal-upload-'))
  const data = await makeSyntheticDataRoot()
  let executionStarted = false, cleanupConfirmed = false
  t.after(async () => {
    if (executionStarted && !cleanupConfirmed) return
    await rm(root, { recursive: true, force: true }); await rm(data.root, { recursive: true, force: true })
  })
  const profile = join(root, 'profile'), web = join(profile, 'node_modules/@deepseek-ai/dsh-pkw-web')
  await mkdir(join(web, 'lib/collaboration'), { recursive: true })
  await writeFile(join(profile, 'package.json'), '{}')
  await writeFile(join(web, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pkw-web', version: '1.0.0-old', type: 'module' }))
  const calls = join(root, 'calls.jsonl'), work = join(root, 'run')
  await writeFile(join(web, 'lib/collaboration/index.js'), `
    import { appendFile, mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const calls = ${JSON.stringify(calls)}, work = ${JSON.stringify(work)};
    const reply = ${JSON.stringify(reply)};
    const storedName = 'stored résumé (final).bin', attachmentId = 'att_contract123';
    let note = '', saves = 0;
    const segment = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    export class CollaborationGateway {
      static async open() { return { async close() {}, async handle(req,res) {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const request = raw ? JSON.parse(raw) : {};
        const send = (value,status=200) => { res.statusCode=status; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value)); };
        if (req.url === '/pkw/login') return send({ok:true,value:{}});
        if (req.url === '/pkw/session') return send({ok:true,value:{csrf:'synthetic',spaces:[{id:'space_contract',kind:'private'}]}});
        const {method,args={}} = request;
        await appendFile(calls, JSON.stringify({method,args})+'\\n');
        if (method === 'createNote') { note=args.markdown; return send({ok:true,value:{noteId:'note_contract'}}); }
        if (method === 'uploadAttachment') {
          if (typeof args.filename !== 'string' || !args.filename || args.mimeType !== 'application/octet-stream' || typeof args.contentBase64 !== 'string' || 'relativePath' in args) return send({ok:false,code:'PKW_REQUEST_FAILED',error:'upload requires filename, mimeType and contentBase64'},400);
          const target=join(work,'data/spaces/space_contract/workspace/attachments',attachmentId);
          await mkdir(target,{recursive:true}); await writeFile(join(target,storedName),Buffer.from(args.contentBase64,'base64'),{mode:0o640});
          return send({ok:true,value:reply === 'valid' ? {attachmentId,filename:storedName} : reply});
        }
        if (method === 'saveNoteBody') {
          if (!args.body.includes('](attachments/'+attachmentId+'/'+segment(storedName)+')')) return send({ok:false,code:'PKW_REQUEST_FAILED',error:'managed link did not use the stored filename'},400);
          saves++; note=args.body; return send({ok:true,value:{}});
        }
        if (method === 'getNote') return send({ok:true,value:{body:note,note:{contentHash:'synthetic-content-hash'},attachments:saves ? [{attachmentId,filename:storedName}] : []}});
        return send({ok:false,error:'unexpected API method'},400);
      }}; }
    }
  `)
  const pack = join(root, 'pack/package'), artifacts = join(root, 'artifacts/web')
  await mkdir(pack, { recursive: true }); await mkdir(artifacts, { recursive: true })
  await writeFile(join(pack, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-pkw-web', version: '2.0.0-new' }))
  execFileSync('tar', ['-czf', join(artifacts, 'web.tgz'), '-C', join(root, 'pack'), 'package'])
  const stub = join(root, 'switch.mjs'), preload = join(root, 'preload.mjs')
  await writeFile(stub, `
    import {realpath} from 'node:fs/promises'; import {join} from 'node:path';
    export const currentRelease = root => realpath(join(root,'current'));
    export const checkReachable = async ({origin}) => ({reachable:(await fetch(origin+'/healthz')).status===200});
    export async function switchRelease({hooks,version}) {
      try { await hooks.verify({expectedVersion:version}); throw new Error('the requested verification fault never happened'); }
      catch(error) { error.report={activationError:{message:error.message}}; throw error; }
    }
  `)
  await writeFile(preload, `
    import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next){
      if(specifier==='./switch-release.mjs' && context.parentURL?.endsWith('/deploy/rehearse-release.mjs')) return {url:${JSON.stringify(pathToFileURL(stub).href)},shortCircuit:true};
      return next(specifier,context);
    }});
  `)
  const reservation = createServer()
  await new Promise(done => reservation.listen(0, '127.0.0.1', done))
  const port = reservation.address().port
  await new Promise(done => reservation.close(done))
  executionStarted = true
  const outcome = await runOwned(process.execPath, [
    '--import', preload, fileURLToPath(new URL('../../deploy/rehearse-release.mjs', import.meta.url)),
    '--work-dir', work, '--profile-source', profile, '--data-source', data.root,
    '--artifact-dir', join(root, 'artifacts'), '--version', '2.0.0-new', '--old-version', '1.0.0-old', '--port', String(port),
    '--force-verify-failure', '--write-during-serve',
  ], {
    cwd: root, log: join(root, 'driver.log'), timeoutMs: 12_000, graceMs: 1_000, onProgress: () => {},
    env: {...process.env,NODE_OPTIONS:'',NODE_PATH:'',PKW_TEST_PROFILE:'',PKW_TEST_DATA_ROOT:'',PKW_TEST_LISTENER_EXIT:''},
  })
  cleanupConfirmed = outcome.groupCleanup.confirmed === true
  const output = outcome.tail
  // This boundary test injects no rollback implementation, so it must not claim a
  // successful deployment even when the business write itself has completed.
  assert.deepEqual({code:outcome.code,signal:outcome.signal,error:outcome.error,timedOut:outcome.timedOut,interrupted:outcome.interrupted}, {code:1,signal:null,error:null,timedOut:false,interrupted:false}, output)
  assert.equal(cleanupConfirmed, true, output)
  const report = JSON.parse(await readFile(join(work, 'report.json'), 'utf8'))
  assert.equal(report.cleanup.ok, true, output)
  assert.equal(report.cleanup.confirmed, true, output)
  assert.throws(() => process.kill(report.cleanup.stop.pid, 0), {code:'ESRCH'})
  return { report, calls: (await readFile(calls,'utf8')).trim().split('\n').map(JSON.parse), work }
}

test('rehearsal entry uploads the product contract and links the returned stored filename', {timeout:40_000}, async t => {
  const {report,calls,work} = await runWriter(t, 'valid')
  assert.equal(report.result.activationError.message, 'rehearsal: injected post-activation verification failure')
  const uploaded = calls.find(x => x.method === 'uploadAttachment').args
  assert.match(uploaded.filename, /^rehearsal-written-during-serve-[a-f0-9]+\.bin$/)
  assert.equal(uploaded.mimeType, 'application/octet-stream')
  assert.equal(Object.hasOwn(uploaded,'relativePath'), false)
  assert.equal(report.phases.writtenDuringServe.linked, true)
  assert.equal(report.phases.writtenDuringServe.attachmentBaseline.file, 'stored résumé (final).bin')
  assert.equal(report.phases.writtenDuringServe.attachmentBaseline.mode, '640')
  assert.equal(report.phases.writtenDuringServe.attachmentBytes, Buffer.from(uploaded.contentBase64,'base64').length)
  const saved = calls.find(x => x.method === 'saveNoteBody').args.body
  assert.match(saved, /attachments\/att_contract123\/stored%20r%C3%A9sum%C3%A9%20%28final%29\.bin/)
  assert.equal(report.phases.injectedFault.afterWrite.attachmentId, 'att_contract123')
  assert.deepEqual(JSON.parse(await readFile(join(work,'served-write.json'),'utf8')), report.phases.writtenDuringServe)
})

for (const [label, reply] of [
  ['missing id',{filename:'stored.bin'}], ['unsafe id',{attachmentId:'../escape',filename:'stored.bin'}],
  ['missing filename',{attachmentId:'att_contract123'}], ['non-string filename',{attachmentId:'att_contract123',filename:42}],
  ['unsafe filename',{attachmentId:'att_contract123',filename:'../escape.bin'}], ['empty filename',{attachmentId:'att_contract123',filename:''}],
]) {
  test(`rehearsal entry refuses upload ${label} before recording a completed write or injected fault`, {timeout:40_000}, async t => {
    const {report,calls,work} = await runWriter(t, reply)
    assert.match(report.result.activationError.message, /the upload reported an invalid attachment identity/)
    assert.equal(calls.some(x => x.method === 'saveNoteBody'), false)
    assert.equal(Object.hasOwn(report.phases,'writtenDuringServe'), false)
    assert.equal(Object.hasOwn(report.phases,'injectedFault'), false)
    assert.equal((await readdir(work)).includes('served-write.json'), false)
    assert.equal(report.exit.faultInjected, false)
  })
}
