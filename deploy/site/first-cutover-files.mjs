/** Small owned filesystem delta for the first unit conversion. Original files are never overwritten. */
import { constants } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readlink, realpath, rename, symlink, unlink, link } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
export const sha256 = value => createHash('sha256').update(value).digest('hex')
const fail=(code,message)=>Object.assign(new Error(message),{code:`PKW_FIRST_${code}`})
export async function exists(path){try{await lstat(path);return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
export async function readPrivateFile(path,{max=4*1024*1024,mode,uid=process.getuid?.()}={}) {
 if(await realpath(path)!==resolve(path))throw fail('PATH','File traverses a symbolic link')
 const h=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW)
 try{const a=await h.stat();if(!a.isFile()||a.size>max||a.uid!==uid||mode!==undefined&&(a.mode&0o7777)!==mode)throw fail('FILE','File ownership, mode, size or kind is invalid')
 const buf=Buffer.alloc(max+1);let n=0;while(n<buf.length){const r=await h.read(buf,n,buf.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead}const b=await h.stat()
 if(n!==a.size||a.size!==b.size||a.mtimeMs!==b.mtimeMs||a.ctimeMs!==b.ctimeMs)throw fail('DRIFT','File changed while being inspected')
 return buf.subarray(0,n)}finally{await h.close()}
}
async function syncDir(path){const h=await open(path,'r');try{await h.sync()}finally{await h.close()}}
export async function writePrivateJson(path,value,{exclusive=false}={}) {
 const parent=dirname(path);if(await realpath(parent)!==parent)throw fail('PATH','Journal parent must be canonical')
 const temp=join(parent,`.cutover-${randomBytes(12).toString('hex')}`),h=await open(temp,'wx',0o600)
 try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync()}finally{await h.close()}
 try{if(exclusive){await link(temp,path);await unlink(temp)}else{if(await exists(path)){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid())throw fail('JOURNAL','Refusing to replace an unowned journal')}await rename(temp,path)}await syncDir(parent)}catch(e){if(await exists(temp))await unlink(temp);throw e}
}
export function independentDropIn({node,current,config}) {
 for(const path of [node,current,config])if(!/^\/[A-Za-z0-9_./-]+$/.test(path))throw fail('PATH','Unit paths must be absolute and literal')
 return `[Service]\nWorkingDirectory=${current}/profile\nExecStart=\nExecStart=${node} ${current}/runner/scripts/serve-collaboration.mjs --profile ${current}/profile --config ${config} --port 3081 --drain-timeout-ms 25000\nUnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH PKW_TEST_GATE_FILE PKW_TEST_LISTENER_EXIT PKW_COMPAT_BIND_NONCE PKW_COMPAT_BIND_PORT\nEnvironment=NODE_DISABLE_COMPILE_CACHE=1 TSX_DISABLE_CACHE=1\n`
}
export async function ownedReferences({current,target,dropIn,content},mode) {
 if(!['absent','owned-or-absent','owned'].includes(mode))throw fail('MODE','Invalid reference check')
 const found={current:false,dropIn:false}
 if(await exists(current)){const s=await lstat(current);if(!s.isSymbolicLink()||await readlink(current)!==target||await realpath(current)!==resolve(dirname(current),target))throw fail('CURRENT_CHANGED','Current pointer is not the exact owned link');found.current=true}
 if(await exists(dropIn)){const bytes=await readPrivateFile(dropIn,{mode:0o644});if(sha256(bytes)!==sha256(content))throw fail('DROPIN_CHANGED','Drop-in does not match the exact owned bytes');found.dropIn=true}
 if(mode==='absent'&&(found.current||found.dropIn)||mode==='owned'&&(!found.current||!found.dropIn))throw fail('REFERENCE_STATE','Owned references are in the wrong state')
 return found
}
export async function installOwnedReferences(options,{checkpoint=async()=>{}}={}) {
 const {current,target,dropIn,content}=options
 await ownedReferences(options,'absent');await checkpoint('before-current')
 await symlink(target,current);await syncDir(dirname(current));await checkpoint('after-current')
 const parent=dirname(dropIn)
 if(!await exists(parent))await mkdir(parent,{mode:0o755})
 const info=await lstat(parent);if(!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o022)!==0||await realpath(parent)!==parent)throw fail('DROPIN_PARENT','Drop-in directory is not trusted')
 const temporary=join(parent,`.pkw-first-${randomBytes(12).toString('hex')}.tmp`),h=await open(temporary,'wx',0o644)
 try{await h.writeFile(content);await h.chmod(0o644);await h.sync()}finally{await h.close()}
 try{await checkpoint('before-drop-in');await link(temporary,dropIn);await syncDir(parent)}finally{await unlink(temporary)}
 await checkpoint('after-drop-in');return ownedReferences(options,'owned')
}
export async function removeOwnedReferences(options,{checkpoint=async()=>{}}={}) {
 // Validate both before deleting either. Refuse changed or pre-existing unrelated references.
 const found=await ownedReferences(options,'owned-or-absent')
 if(found.dropIn){await checkpoint('before-remove-drop-in');await ownedReferences(options,'owned-or-absent');await unlink(options.dropIn);await syncDir(dirname(options.dropIn))}
 if(found.current){await checkpoint('before-remove-current');await ownedReferences(options,'owned-or-absent');await unlink(options.current);await syncDir(dirname(options.current))}
 return ownedReferences(options,'absent')
}
