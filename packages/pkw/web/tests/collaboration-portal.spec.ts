import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { renderPortal } from '../src/collaboration/portal-ui.ts'

const page = renderPortal()
const script = /<script>([\s\S]*?)<\/script>/.exec(page)![1]!

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// This small DOM surface runs the entire emitted script and its actual listeners.
// It models disabled/hidden/inert controls and literal text sinks; layout, native
// form validation, and browser focus rendering remain browser acceptance work.
class PortalElement {
  parent: PortalElement | null = null
  children: PortalElement[] = []
  attributes: Record<string, string> = {}
  dataset: Record<string, string> = {}
  events: Record<string, Array<(event: any) => unknown>> = {}
  hidden = false
  disabled = false
  inert = false
  open = false
  selected = false
  className = ''
  type = ''
  href = ''
  private ownValue: string | undefined
  private literal = ''

  constructor(readonly tagName: string, readonly document: PortalDocument) {}
  get value(): string { return this.ownValue ?? (this.tagName === 'select' ? this.children[0]?.value ?? '' : '') }
  set value(value: string) { this.ownValue = value }
  get textContent(): string { return this.literal + this.children.map(child => child.textContent).join('') }
  set textContent(value: string) { this.replaceChildren(); this.literal = String(value) }
  set innerHTML(_value: string) { throw new Error('Untrusted content reached an HTML sink') }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value
    if (name === 'hidden') this.hidden = true
    if (name === 'disabled') this.disabled = true
    if (name === 'value') this.value = value
  }
  append(...children: PortalElement[]) {
    for (const child of children) { child.parent = this; this.children.push(child) }
  }
  replaceChildren(...children: PortalElement[]) {
    this.children.forEach(child => { child.parent = null })
    this.children = []
    this.literal = ''
    if (this.tagName === 'select') this.ownValue = undefined
    this.append(...children)
  }
  querySelectorAll(selector: string): PortalElement[] {
    const match = /^(\w+)(?:\[([\w-]+)=['"]?([^'"\]]+)['"]?\])?$/.exec(selector)
    if (!match) throw new Error('Unsupported test selector: ' + selector)
    return this.children.flatMap(child => [
      ...(child.tagName === match[1] && (!match[2] || child.attributes[match[2]] === match[3]) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
  querySelector(selector: string): PortalElement | null { return this.querySelectorAll(selector)[0] ?? null }
  addEventListener(type: string, listener: (event: any) => unknown) { (this.events[type] ??= []).push(listener) }
  get blocked(): boolean { return this.disabled || this.hidden || this.inert || Boolean(this.parent?.blocked) }
  async emit(type: string, event: Record<string, unknown> = {}) {
    if (this.blocked) return
    for (const listener of this.events[type] ?? []) await listener.call(this, event)
  }
  focus() { if (!this.blocked) this.document.activeElement = this }
  select() { this.selected = true }
}

class PortalDocument {
  root = new PortalElement('body', this)
  activeElement: PortalElement | null = null
  constructor(html: string) {
    const stack = [this.root]
    const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script>'))
    for (const token of body.match(/<[^>]+>|[^<]+/g) ?? []) {
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
      if (token.startsWith('<')) {
        const tag = /^<([\w-]+)/.exec(token)?.[1]
        if (!tag) continue
        const node = this.createElement(tag)
        const attrs = token.slice(tag.length + 1, -1)
        for (const attribute of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attribute[1]!, attribute[2] ?? '')
        stack.at(-1)!.append(node)
        if (!['input', 'meta', 'link', 'br', 'hr', 'img'].includes(tag)) stack.push(node)
      } else stack.at(-1)!.append(this.createTextNode(token))
    }
  }
  createElement(tag: string) { return new PortalElement(tag, this) }
  createTextNode(text: string) { const node = new PortalElement('#text', this); node.textContent = text; return node }
  getElementById(id: string): PortalElement {
    const visit = (node: PortalElement): PortalElement | undefined => node.attributes.id === id ? node : node.children.map(visit).find(Boolean)
    const node = visit(this.root)
    if (!node) throw new Error('Missing element: ' + id)
    return node
  }
}

type Request = { path: string; input: any; options: { headers: Record<string, string>; method?: string; body?: string } }
type Space = { id: string; name: string; kind: string; role: string }
type Session = { username: string; csrf: string; spaces: Space[] }
const spaces: Space[] = [
  { id: 'private-alice', name: 'Alice 私人', kind: 'private', role: 'owner' },
  { id: 'team-a', name: '团队 A', kind: 'team', role: 'owner' },
  { id: 'team-b', name: '团队 B', kind: 'team', role: 'owner' },
]
const alice: Session = { username: 'alice', csrf: 'alice-csrf', spaces }
const bob: Session = { username: 'bob', csrf: 'bob-csrf', spaces: [{ id: 'private-bob', name: 'Bob 私人', kind: 'private', role: 'owner' }] }
const plan = {
  token: 'preview-a', title: '私人原稿', targetName: '团队 A', frontmatter: 'secret: true', body: '私密正文',
  attachments: [{ filename: '私人附件.pdf', sizeBytes: 123 }], warnings: ['团队副本独立保存'],
}
function response(value: unknown, status = 200, error?: string) {
  return { ok: status === 200, status, json: async () => status === 200 ? { ok: true, value } : { ok: false, error } }
}
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve() }

function harness(initial?: (request: Request) => unknown) {
  const document = new PortalDocument(page)
  const requests: Request[] = []
  let session = alice
  let handler = initial
  const fallback = (request: Request): unknown => {
    if (request.path === '/pkw/session') return response(session)
    if (request.path === '/pkw/login') { session = request.input.username === 'bob' ? bob : alice; return response({}) }
    if (request.input?.action === 'members') return response([
      { id: 'alice', username: 'alice', role: 'owner' },
      { id: 'colleague', username: request.input.spaceId + ' 同事', role: 'editor' },
    ])
    if (request.input?.action === 'invite') return response({ token: 'invite-' + request.input.spaceId })
    if (request.input?.action === 'audit') return response([{ at: 0, action: request.input.spaceId + ' 操作', actor: 'alice' }])
    if (request.input?.method === 'listNotes') return response([{ noteId: 'note-a', title: '私人原稿', relativePath: '私人原稿.md' }])
    if (request.input?.action === 'preview') return response(plan)
    if (request.input?.action === 'commit') return response({ status: 'complete', targetSpaceId: 'team-a' })
    return response({})
  }
  const fetch = vi.fn(async (path: string, options: Request['options']) => {
    const request = { path, options, input: options.body ? JSON.parse(options.body) : undefined }
    requests.push(request)
    return await (handler?.(request) ?? fallback(request))
  })
  const clipboard = vi.fn(async (_text: string) => {})
  runInNewContext(script, {
    document, fetch, navigator: { clipboard: { writeText: clipboard } }, confirm: () => true,
    location: { origin: 'http://localhost', pathname: '/pkw', hash: '' },
    history: { replaceState: vi.fn() }, URLSearchParams,
  })
  const el = (id: string) => document.getElementById(id)
  const click = (id: string) => el(id).emit('click')
  const submit = (id: string) => el(id).emit('submit', { preventDefault() {}, submitter: el(id).querySelector('button') })
  const open = (name: string) => {
    const card = el('spaces').querySelectorAll('article').find(card => card.querySelector('h2')?.textContent === name)
    if (!card) throw new Error('No space card: ' + name)
    return card.querySelector('button')!.emit('click')
  }
  const rowButton = (name: string) => el('members').querySelectorAll('button').find(button => button.textContent === name)!
  const preview = async () => { await click('load-share-notes'); await submit('share-form') }
  return { document, el, click, submit, open, rowButton, preview, requests, clipboard, fallback, setHandler: (next?: typeof handler) => { handler = next } }
}

describe('collaboration portal artifact', () => {
  it('ships valid complete browser code with semantic forms and no HTML interpolation sink', () => {
    expect(() => new Function(script)).not.toThrow()
    for (const id of ['login-form', 'register-form', 'password-form', 'share-form', 'share-preview', 'management-title']) expect(page).toContain('id="' + id + '"')
    expect(page).toContain('autocomplete="new-password"')
    expect(page).toContain('aria-live="polite"')
    expect(script).not.toContain('innerHTML')
  })

  it('binds invite output to its management space and labels the space and granted role', async () => {
    const h = harness(); await settle(); await h.open('团队 A')
    const old = deferred<unknown>()
    h.setHandler(req => req.input?.action === 'invite' && req.input.spaceId === 'team-a' ? old.promise : undefined)
    const pending = h.click('invite-button')
    await h.open('团队 B')
    h.el('invite-role').value = 'viewer'
    await h.click('invite-button')
    old.resolve(response({ token: 'secret-invite-a' })); await pending
    expect(h.el('management-title').textContent).toContain('团队 B')
    expect(h.el('invite-link').value).toContain('invite-team-b')
    expect(h.el('invite-link').value).not.toContain('secret-invite-a')
    expect(h.el('invite-output').querySelector('label')!.textContent).toContain('团队 B · 只读成员')
    expect(h.requests.find(req => req.input?.action === 'invite')?.options.headers['X-PKW-CSRF']).toBe('alice-csrf')
  })

  it.each(['保存角色', '移除', '转让所有权'])('does not reopen old members after a late %s mutation', async (label) => {
    const h = harness(); await settle(); await h.open('团队 A')
    const old = deferred<unknown>()
    h.setHandler(req => ['setRole', 'transfer'].includes(req.input?.action) ? old.promise : undefined)
    const pending = h.rowButton(label).emit('click')
    await h.open('团队 B')
    const count = h.requests.length
    old.resolve(response({})); await pending
    expect(h.el('management-title').textContent).toContain('团队 B')
    expect(h.el('members').textContent).toContain('team-b 同事')
    expect(h.el('members').textContent).not.toContain('team-a 同事')
    expect(h.requests).toHaveLength(count)
    expect(h.el('status').textContent).toBe('')
  })

  it('ignores stale revoke completion and audit output after switching spaces', async () => {
    const h = harness(); await settle(); await h.open('团队 A')
    const revoke = deferred<unknown>(), audit = deferred<unknown>()
    h.setHandler(req => req.input?.action === 'revokeInvites' ? revoke.promise : req.input?.action === 'audit' && req.input.spaceId === 'team-a' ? audit.promise : undefined)
    const revoking = h.click('revoke-button'), auditing = h.click('audit-button')
    await h.open('团队 B'); await h.click('invite-button'); await h.click('audit-button')
    revoke.resolve(response({})); audit.resolve(response([{ at: 0, action: 'private-A-log', actor: 'alice' }]))
    await Promise.all([revoking, auditing])
    expect(h.el('invite-link').value).toContain('invite-team-b')
    expect(h.el('audit').textContent).toContain('team-b 操作')
    expect(h.el('audit').textContent).not.toContain('private-A-log')
    expect(h.el('status').textContent).not.toContain('团队 A')
  })

  it('suppresses old errors and clipboard fallback focus after changing management space', async () => {
    const h = harness(); await settle(); await h.open('团队 A'); await h.click('invite-button')
    const clipboard = deferred<void>(), invite = deferred<unknown>()
    h.clipboard.mockImplementationOnce(() => clipboard.promise)
    const copying = h.click('copy-link')
    h.setHandler(req => req.input?.action === 'invite' && req.input.spaceId === 'team-a' ? invite.promise : undefined)
    const inviting = h.click('invite-button')
    await h.open('团队 B')
    const focused = h.document.activeElement
    clipboard.reject(new Error('old clipboard error')); invite.resolve(response(null, 403, 'A private failure'))
    await Promise.all([copying, inviting])
    expect(h.document.activeElement).toBe(focused)
    expect(h.el('status').textContent).toBe('')
    expect(h.el('invite-output').hidden).toBe(true)
  })

  it('does not steal focus from a newer same-space action when clipboard access fails late', async () => {
    const h = harness(); await settle(); await h.open('团队 A'); await h.click('invite-button')
    const clipboard = deferred<void>()
    h.clipboard.mockImplementationOnce(() => clipboard.promise)
    const copying = h.click('copy-link')
    h.el('audit-button').focus(); await h.click('audit-button')
    clipboard.reject(new Error('clipboard permission denied')); await copying
    expect(h.document.activeElement).toBe(h.el('audit-button'))
    expect(h.el('status').textContent).toBe('')
    expect(h.el('invite-link').value).toContain('invite-team-a')
  })

  it('clears private projections immediately on logout and rejects old members after a new login', async () => {
    const h = harness(); await settle(); await h.open('团队 A'); await h.click('invite-button'); await h.preview()
    const members = deferred<unknown>(), logout = deferred<unknown>()
    h.setHandler(req => req.input?.action === 'members' ? members.promise : req.input?.action === 'logout' ? logout.promise : undefined)
    const loading = h.open('团队 B')
    const exiting = h.click('logout')
    for (const id of ['members', 'audit', 'share-preview-title', 'share-scope', 'share-body', 'share-attachments', 'share-warnings', 'share-note', 'share-target', 'share-result']) expect(h.el(id).textContent).toBe('')
    expect(h.el('invite-link').value).toBe('')
    expect(h.el('auth').inert).toBe(true)
    expect(h.el('home').hidden).toBe(true)
    h.el('username').value = 'bob'; h.el('password').value = 'not-sent-yet'
    await h.submit('login-form')
    expect(h.requests.filter(req => req.path === '/pkw/login')).toHaveLength(0)
    logout.resolve(response({})); await exiting
    h.el('password').value = 'long-enough-password'
    await h.submit('login-form')
    members.resolve(response([{ id: 'old', username: 'Alice private colleague', role: 'editor' }])); await loading
    expect(h.el('account-label').textContent).toBe('bob')
    expect(h.el('members').textContent).toBe('')
    expect(h.el('management').hidden).toBe(true)
    expect(h.el('share-preview').hidden).toBe(true)
    expect(h.el('spaces').textContent).toContain('Bob 私人')
  })

  it.each(['resolve', 'reject'] as const)('does not let initial session %s replace a newer login', async (result) => {
    const initial = deferred<unknown>()
    let sessionReads = 0
    const h = harness(req => req.path === '/pkw/session' && ++sessionReads === 1 ? initial.promise : undefined)
    h.el('username').value = 'bob'; h.el('password').value = 'long-enough-password'
    await h.submit('login-form')
    if (result === 'resolve') initial.resolve(response(alice)); else initial.reject(new Error('old unauthenticated request'))
    await settle()
    expect(h.el('account-label').textContent).toBe('bob')
    expect(h.el('auth').hidden).toBe(true)
    expect(h.el('home').hidden).toBe(false)
  })

  it('invalidates startup session loading during registration and returns focus after unlocking auth', async () => {
    const initial = deferred<unknown>()
    const h = harness(req => req.path === '/pkw/session' ? initial.promise : undefined)
    h.el('register-token').value = 'invite'; h.el('register-name').value = 'new-user'; h.el('register-password').value = 'long-enough-password'
    await h.submit('register-form')
    initial.resolve(response(alice)); await settle()
    expect(h.el('auth').hidden).toBe(false)
    expect(h.el('username').value).toBe('new-user')
    expect(h.el('password').value).toBe('')
    expect(h.document.activeElement).toBe(h.el('password'))
  })

  it('preserves login fields entered before the initial unauthenticated session check finishes', async () => {
    const initial = deferred<unknown>()
    const h = harness(req => req.path === '/pkw/session' ? initial.promise : undefined)
    h.el('username').value = 'typing-user'; h.el('password').value = 'unfinished-password'
    initial.resolve(response(null, 401, 'Please log in')); await settle()
    expect(h.el('auth').hidden).toBe(false)
    expect(h.el('username').value).toBe('typing-user')
    expect(h.el('password').value).toBe('unfinished-password')
  })

  it.each(['success', 'unauthorized'] as const)('keeps the newest refresh despite old %s and preserves newer form input', async (oldResult) => {
    const h = harness(); await settle()
    const create = deferred<unknown>(), earlier = deferred<unknown>(), later = deferred<unknown>()
    let refreshes = 0
    h.setHandler(req => req.input?.action === 'createTeam' ? create.promise : req.path === '/pkw/session' ? (++refreshes === 1 ? earlier.promise : later.promise) : undefined)
    h.el('team-name').value = 'old name'
    const creating = h.submit('team-form')
    h.el('team-name').value = 'new unfinished name'
    create.resolve(response({})); await settle()
    h.el('accept-token').value = 'new-invite'
    const accepting = h.submit('accept-form'); await settle()
    later.resolve(response({ ...alice, spaces: [...spaces, { id: 'new', name: '最新团队', kind: 'team', role: 'editor' }] })); await accepting
    earlier.resolve(oldResult === 'success' ? response(alice) : response(null, 401, 'old expired session')); await creating
    expect(h.el('account-label').textContent).toBe('alice')
    expect(h.el('spaces').textContent).toContain('最新团队')
    expect(h.el('team-name').value).toBe('new unfinished name')
    expect(h.el('status').textContent).toBe('已加入团队共享空间')
  })

  it('renders all preview text literally, including hostile Markdown/HTML and attachment names', async () => {
    const h = harness(); await settle()
    const hostile = '<img src=x onerror="alert(1)"><script>window.bad=true</script>'
    h.setHandler(req => req.input?.action === 'preview' ? response({ ...plan, title: hostile, frontmatter: 'tag: ' + hostile, body: hostile, attachments: [{ filename: hostile, sizeBytes: 1 }], warnings: [hostile] }) : undefined)
    await h.preview()
    expect(h.el('share-preview').hidden).toBe(false)
    expect(h.el('share-body').textContent).toBe('tag: ' + hostile + '\n' + hostile)
    for (const id of ['share-preview-title', 'share-body', 'share-attachments', 'share-warnings']) {
      expect(h.el(id).textContent).toContain(hostile)
      expect(h.el(id).querySelectorAll('img')).toHaveLength(0)
      expect(h.el(id).querySelectorAll('script')).toHaveLength(0)
    }
    expect(h.document.activeElement).toBe(h.el('confirm-share'))
  })

  it('discards a preview whose selected target changed while it was loading', async () => {
    const h = harness(); await settle(); await h.click('load-share-notes')
    const preview = deferred<unknown>()
    h.setHandler(req => req.input?.action === 'preview' ? preview.promise : undefined)
    const loading = h.submit('share-form')
    h.el('share-target').value = 'team-b'; await h.el('share-target').emit('change')
    preview.resolve(response(plan)); await loading
    expect(h.el('share-preview').hidden).toBe(true)
    expect(h.el('share-body').textContent).toBe('')
    expect(h.el('share-scope').textContent).toBe('')
  })

  it('locks submitted sharing against duplicates and ignores its result after logout', async () => {
    const h = harness(); await settle(); await h.preview()
    const commit = deferred<unknown>()
    h.setHandler(req => req.input?.action === 'commit' ? commit.promise : undefined)
    const copying = h.click('confirm-share')
    expect(h.el('share-result').textContent).toContain('请求已提交')
    for (const id of ['share-note', 'share-target', 'cancel-share', 'confirm-share', 'load-share-notes']) expect(h.el(id).disabled).toBe(true)
    await h.click('confirm-share'); await h.click('cancel-share')
    expect(h.requests.filter(req => req.input?.action === 'commit')).toHaveLength(1)
    await h.click('logout')
    commit.resolve(response({ status: 'complete', targetSpaceId: 'team-a' })); await copying
    expect(h.el('share-result').textContent).toBe('')
    expect(h.el('share-body').textContent).toBe('')
    expect(h.el('home').hidden).toBe(true)
    expect(h.el('status').textContent).toBe('已退出登录')
  })

  it('retains the same confirmation receipt for a user retry after an uncertain network result', async () => {
    const h = harness(); await settle(); await h.preview()
    let attempt = 0
    h.setHandler(req => req.input?.action === 'commit' && attempt++ === 0 ? Promise.reject(new Error('network interrupted')) : undefined)
    await h.click('confirm-share')
    expect(h.el('share-preview').hidden).toBe(false)
    expect(h.el('share-result').textContent).toContain('同一预览重试')
    expect(h.el('confirm-share').disabled).toBe(false)
    await h.click('confirm-share')
    const commits = h.requests.filter(req => req.input?.action === 'commit')
    expect(commits.map(req => req.input.token)).toEqual(['preview-a', 'preview-a'])
    expect(h.el('share-result').textContent).toContain('已复制到 团队 A，私人原稿保留')
  })

  it('invalidates private pending reads when changing password and returns to login', async () => {
    const h = harness(); await settle()
    const members = deferred<unknown>(), password = deferred<unknown>()
    h.setHandler(req => req.input?.action === 'members' ? members.promise : req.input?.action === 'password' ? password.promise : undefined)
    const loading = h.open('团队 A')
    h.el('old-password').value = 'old-secret'; h.el('new-password').value = 'long-new-secret'
    const changing = h.submit('password-form')
    members.resolve(response([{ id: 'old', username: 'Old secret member', role: 'editor' }])); await loading
    expect(h.el('members').textContent).toBe('')
    password.resolve(response({})); await changing
    expect(h.el('auth').hidden).toBe(false)
    expect(h.el('auth').inert).toBe(false)
    expect(h.el('old-password').value).toBe('')
    expect(h.el('new-password').value).toBe('')
    expect(h.el('status').textContent).toBe('密码已修改，请重新登录')
  })
})
