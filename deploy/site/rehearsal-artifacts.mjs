/** Read-only gates for real rehearsal artifacts. No install, extraction or version rewriting. */
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { dirname, join, resolve, sep } from 'node:path'

const PKW = /^@deepseek-ai\/dsh-pkw-[a-z0-9][a-z0-9-]*$/
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_ARCHIVE = 128 * 1024 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const reject = message => { throw Object.assign(new Error(message), { code: 'PKW_REHEARSAL_ARTIFACT_INVALID' }) }
const inside = (root, path) => path === root || path.startsWith(root + sep)

async function directory(path, label) {
  const absolute = resolve(path)
  const info = await lstat(absolute)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) reject(`${label} must be a canonical directory`)
  return absolute
}

async function regularBytes(path, label, limit = MAX_ARCHIVE) {
  const absolute = resolve(path)
  if (await realpath(absolute) !== absolute) reject(`${label} must not traverse a symbolic link`)
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > limit) reject(`${label} must be a bounded regular file`)
    const bytes = await file.readFile()
    const after = await file.stat()
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) reject(`${label} changed while being read`)
    return bytes
  } finally { await file.close() }
}

function json(bytes, label) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { reject(`${label} is not valid JSON`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(`${label} must be a JSON object`)
  return value
}

function octal(field, label) {
  const text = field.toString('ascii').replace(/\0.*$/, '').trim()
  if (text && !/^[0-7]+$/.test(text)) reject(`Invalid tar ${label}`)
  const value = text ? Number.parseInt(text, 8) : 0
  if (!Number.isSafeInteger(value) || value < 0) reject(`Invalid tar ${label}`)
  return value
}

function tarText(field) {
  const end = field.indexOf(0)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(end < 0 ? field : field.subarray(0, end)) }
  catch { reject('Invalid UTF-8 in tar member name') }
}

function memberPath(value, isDirectory) {
  const name = isDirectory ? value.replace(/\/$/, '') : value
  if (!name || name.startsWith('/') || name.includes('\\') || /[\0-\x1f\x7f]/.test(name)) reject('Unsafe tar member path')
  const parts = name.split('/')
  if (parts[0] !== 'package' || parts.some(part => !part || part === '.' || part === '..')) reject('Tar member must stay inside package/')
  if (parts.length === 1 && !isDirectory) reject('Tar package root must be a directory')
  return parts.slice(1).join('/')
}

function paxFields(bytes) {
  const result = {}
  let offset = 0
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset)
    if (space < 0) reject('Invalid PAX record')
    const lengthText = bytes.subarray(offset, space).toString('ascii')
    if (!/^[1-9][0-9]*$/.test(lengthText)) reject('Invalid PAX length')
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) reject('Invalid PAX extent')
    const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals <= 0) reject('Invalid PAX field')
    const key = record.slice(0, equals), value = record.slice(equals + 1)
    if (Object.hasOwn(result, key)) reject('Duplicate PAX field')
    if (key === 'linkpath' || key.startsWith('GNU.sparse.')) reject('Tar links and sparse members are unsupported')
    result[key] = value
    offset += length
  }
  return result
}

/** npm tar payloads: regular files/directories, PAX metadata, and GNU long names only. */
function unpack(archive) {
  let bytes
  try { bytes = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE }) } catch { reject('Artifact is not a bounded gzip tar archive') }
  const files = new Map(), kinds = new Map()
  let offset = 0, ended = false, globalPax = {}, localPax = null, longName = null
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) {
      if (bytes.length - offset < 1024 || !bytes.subarray(offset).every(byte => byte === 0)) reject('Invalid tar end marker')
      ended = true
      break
    }
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]
    if (checksum !== octal(header.subarray(148, 156), 'checksum')) reject('Tar checksum mismatch')
    const size = octal(header.subarray(124, 136), 'size')
    const dataStart = offset + 512, next = dataStart + Math.ceil(size / 512) * 512
    if (next > bytes.length) reject('Truncated tar member')
    const body = bytes.subarray(dataStart, dataStart + size)
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    // GNU headers reuse the POSIX prefix area for other metadata.
    const prefix = header.subarray(257, 263).equals(Buffer.from('ustar\0')) ? tarText(header.subarray(345, 500)) : ''
    const short = tarText(header.subarray(0, 100))
    const headerName = prefix ? `${prefix}/${short}` : short
    offset = next
    if (type === 'x' || type === 'g') {
      const fields = paxFields(body)
      if (type === 'g') {
        if (fields.path !== undefined || fields.size !== undefined) reject('Global PAX path/size overrides are unsupported')
        globalPax = { ...globalPax, ...fields }
      } else {
        if (localPax) reject('Repeated local PAX header')
        localPax = fields
      }
      continue
    }
    if (type === 'L') {
      if (longName !== null) reject('Repeated GNU long name')
      longName = tarText(body)
      continue
    }
    if (!['0', '5'].includes(type)) reject('Tar links and special members are unsupported')
    if (tarText(header.subarray(157, 257))) reject('Regular tar members must not carry a link target')
    const pax = { ...globalPax, ...localPax }
    if (pax.size !== undefined && (!/^[0-9]+$/.test(pax.size) || Number(pax.size) !== size)) reject('PAX size does not match tar header')
    const name = memberPath(pax.path ?? longName ?? headerName, type === '5')
    localPax = null; longName = null
    if (kinds.has(name)) reject('Duplicate tar member path')
    for (const [previous, kind] of kinds) {
      if ((name.startsWith(previous + '/') && kind === 'file') || (previous.startsWith(name + '/') && type === '0')) reject('Tar file/directory path collision')
    }
    if (type === '5' && size !== 0) reject('Tar directory has a payload')
    kinds.set(name, type === '5' ? 'directory' : 'file')
    if (type === '0') files.set(name, body)
  }
  if (!ended || localPax || longName !== null) reject('Incomplete tar archive')
  const manifestBytes = files.get('package.json')
  if (!manifestBytes) reject('Artifact has no package/package.json')
  const manifest = json(manifestBytes, 'Artifact manifest')
  if (!PACKAGE.test(manifest.name ?? '') || typeof manifest.version !== 'string' || !manifest.version) reject('Artifact manifest name/version is invalid')
  return { manifest, files }
}

async function tarball(path) {
  const bytes = await regularBytes(path, 'Artifact')
  return { ...unpack(bytes), sha256: digest(bytes), bytes: bytes.length }
}

/** Re-read a previously verified artifact. Return validated payload bytes without extracting them. */
export async function readArtifactFiles(artifact) {
  if (!artifact || !PKW.test(artifact.name ?? '') || typeof artifact.version !== 'string' || !SHA256.test(artifact.sha256 ?? '') || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || typeof artifact.tarball !== 'string') reject('Invalid verified artifact request')
  const item = await tarball(artifact.tarball)
  if (item.manifest.name !== artifact.name || item.manifest.version !== artifact.version || item.sha256 !== artifact.sha256 || item.bytes !== artifact.bytes) reject(`Artifact changed before payload verification: ${artifact.name}`)
  return item
}

/** Verify real tarballs against the parent receipt. Return only the expected PKW release. */
export async function readReleaseArtifacts(dir, version, expectedNames, { receiptPath = join(dirname(resolve(dir)), 'receipt.json') } = {}) {
  if (typeof version !== 'string' || !version || !Array.isArray(expectedNames) || expectedNames.length === 0 || expectedNames.some(name => !PKW.test(name)) || new Set(expectedNames).size !== expectedNames.length) reject('Expected release names/version are invalid')
  const root = await directory(dir, 'Artifact root')
  // Receipt validation precedes archive reads; no private receipt fields are returned.
  const receipt = json(await regularBytes(receiptPath, 'Release receipt', 16 * 1024 * 1024), 'Release receipt')
  if (receipt.version !== version || !Array.isArray(receipt.artifacts)) reject('Release receipt version/artifacts are invalid')
  const expected = new Set(expectedNames), records = new Map()
  for (const record of receipt.artifacts) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) reject('Invalid receipt artifact record')
    if (!PKW.test(record.name ?? '')) continue
    if (!expected.has(record.name) || record.version !== version || records.has(record.name)) reject('Receipt has an extra, duplicate or wrong-version PKW artifact')
    if (!SHA256.test(record.sha256 ?? '') || (record.bytes !== undefined && (!Number.isSafeInteger(record.bytes) || record.bytes < 0))) reject('Receipt artifact digest/size is invalid')
    records.set(record.name, record)
  }
  if (records.size !== expected.size) reject('Receipt is missing an expected PKW artifact')
  const paths = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) reject('Artifact directory entries must not be symbolic links')
    if (entry.isFile() && entry.name.endsWith('.tgz')) paths.push(path)
    else if (entry.isDirectory()) {
      await directory(path, 'Artifact package directory')
      for (const nested of await readdir(path, { withFileTypes: true })) {
        if (!nested.name.endsWith('.tgz')) continue
        if (!nested.isFile() || nested.isSymbolicLink()) reject('Artifact tarball must be a regular file')
        paths.push(join(path, nested.name))
      }
    } else if (entry.name.endsWith('.tgz')) reject('Artifact tarball must be a regular file')
  }
  const result = new Map()
  for (const path of paths.sort()) {
    const item = await tarball(path)
    const { name, version: actualVersion } = item.manifest
    if (!PKW.test(name)) continue // Support peers are repacked separately, never trusted as release inputs.
    if (!expected.has(name) || actualVersion !== version || result.has(name)) reject('Artifact directory has an extra, duplicate or wrong-version PKW tarball')
    const record = records.get(name)
    if (record.sha256 !== item.sha256 || (record.bytes !== undefined && record.bytes !== item.bytes)) reject(`Receipt digest/size mismatch for ${name}`)
    result.set(name, { name, version, tarball: path, sha256: item.sha256, bytes: item.bytes, manifest: item.manifest })
  }
  if (result.size !== expected.size) reject('Artifact directory is missing an expected PKW tarball')
  return expectedNames.map(name => result.get(name))
}

/** Compare an installed or unpacked profile/node_modules/<name> tree to the original tar bytes. */
export async function verifyArtifactPayload(profile, artifacts) {
  const root = await directory(profile, 'Profile')
  if (!Array.isArray(artifacts) || artifacts.length === 0) reject('No artifacts to verify')
  const seen = new Set(), results = []
  for (const artifact of artifacts) {
    if (!artifact || !PKW.test(artifact.name ?? '') || seen.has(artifact.name)) reject('Invalid or duplicate artifact payload request')
    seen.add(artifact.name)
    const item = await readArtifactFiles(artifact)
    const packageDir = join(root, 'node_modules', artifact.name)
    const actual = await realpath(packageDir)
    if (!inside(root, actual) || !(await lstat(actual)).isDirectory()) reject(`Installed package leaves profile: ${artifact.name}`)
    for (const [name, source] of item.files) {
      const target = join(actual, ...name.split('/'))
      if (!inside(actual, target) || await realpath(target) !== target) reject(`Installed payload traverses a symbolic link: ${artifact.name}`)
      const installed = await regularBytes(target, 'Installed payload')
      if (installed.length !== source.length || digest(installed) !== digest(source)) reject(`Installed payload differs from tarball: ${artifact.name}/${name}`)
    }
    results.push({ name: artifact.name, version: artifact.version, files: item.files.size, sha256: item.sha256 })
  }
  return { ok: true, packages: results }
}
