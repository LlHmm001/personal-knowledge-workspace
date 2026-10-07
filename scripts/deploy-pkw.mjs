import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { activate, checkUiReview, deploymentErrorDetails, exists, hostFingerprint, jsonFile, run, stagePackages, validateHook, validateRegistry, validateVersion, verifyHttp } from './deployment.mjs'

const { values } = parseArgs({ options: {
  profile: { type: 'string' }, version: { type: 'string' }, url: { type: 'string' },
  registry: { type: 'string', default: 'http://localhost:4873' },
  'ui-review': { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean' },
} })
if (values.help) {
  console.log('PKW_STOP_HOOK=/absolute/stop PKW_START_HOOK=/absolute/start DSH_HARNESS_ROOT=/opt/deepseek-harness pnpm run deploy --profile /root/.dsh/profiles/web --version 0.1.1-pkw.1 --url http://127.0.0.1:3080 [--ui-review /path/review.json] [--dry-run]')
  process.exit(0)
}
const version = validateVersion(values.version)
const registry = validateRegistry(values.registry)
if (!values.profile || !isAbsolute(values.profile)) throw new Error('--profile must be an absolute installed profile directory')
if (!values.url) throw new Error('--url is required for pre/post-restart verification')
const profile = resolve(values.profile)
const installed = await jsonFile(join(profile, 'package.json'))
if (!installed.dependencies?.['@deepseek-ai/dsh-pkw-web']) throw new Error('Profile must already declare dsh-pkw-web')
const stop = await validateHook(process.env.PKW_STOP_HOOK, 'PKW_STOP_HOOK')
const start = await validateHook(process.env.PKW_START_HOOK, 'PKW_START_HOOK')
const releaseRoot = join(dirname(profile), '.pkw-deployments', version)
if (await exists(releaseRoot)) throw new Error(`Release attempt already exists; inspect its receipt before using a new version: ${releaseRoot}`)
const lock = join(profile, '.pkw-deploy.lock')
await mkdir(lock) // fail closed if another deployment is running
try {
  await run('pnpm', ['typecheck'])
  await run('pnpm', ['test'])
  await run('pnpm', ['build'])
  const uiReview = await checkUiReview(profile, values['ui-review'])
  const beforeHost = await hostFingerprint(profile)
  await verifyHttp(values.url, 1)
  if (values['dry-run']) {
    console.log(JSON.stringify({ status: 'preflight-passed', version, registry, profile, uiReview, mutations: 'none to registry/profile installation/service' }, null, 2))
  } else {
    await mkdir(releaseRoot, { recursive: true, mode: 0o700 })
    const receipt = { version, registry, profile, status: 'preparing', uiReview, beforeHost, startedAt: new Date().toISOString() }
    const save = () => writeFile(join(releaseRoot, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    await save()
    try {
      const artifacts = await stagePackages(join(releaseRoot, 'packages'), version, registry)
      receipt.artifacts = artifacts
      receipt.status = 'publishing'
      await save()
      // Publish all immutable artifacts before stopping/changing the profile.
      // A partial publish leaves the running installation alone; never unpublish.
      for (const artifact of artifacts) await run('npm', ['publish', artifact.tarball, '--ignore-scripts', '--registry', registry, '--tag', 'pkw-candidate'], artifact.dir)
      receipt.status = 'activating'
      await save()
      receipt.verification = await activate({ profile, backup: join(releaseRoot, 'backup'), artifacts, registry, stop, start, url: values.url, beforeHost })
      receipt.status = 'passed'
      await save()
      console.log(`Deployment verified. Receipt: ${join(releaseRoot, 'receipt.json')}`)
    } catch (error) {
      receipt.status = 'failed'
      receipt.errorDetails = deploymentErrorDetails(error)
      receipt.error = receipt.errorDetails.message
      await save()
      throw error
    }
  }
} finally {
  await rm(lock, { recursive: true, force: true })
}
