# DeepSeek Harness Adapter Report (Phase 0)

> Project: Personal Knowledge Workspace (PKW)
> Purpose: prove, before any business plugin is written, how the PKW design's vocabulary
> ("Bundle / Profile / Plugin / Service / Event Bus / Tool Registry / MCP / Web Extension")
> maps onto the **actual** extension system of DeepSeek Harness.
> Source checkout: `/opt/deepseek-harness` (verified against `docs/`, `packages/`, `apps/cli/config/`, `examples/`).

---

## 0. The one finding that changes the plan

DeepSeek Harness is **not** a generic "plugin loader with bundles and profiles" in the sense the PKW
design assumes. Its extension system is **Cordis**, vendored at `vendor/cordis`, and everything —
the LLM route, the tool registry, the sandbox, the Web shell, an agent's persona — is a **plugin row**
in a YAML composition. The composition happens on **three distinct planes**, and the PKW design's
single "Bundle / Profile" axis must be split across them:

```text
PKW design's mental model          DeepSeek Harness reality
───────────────────────────        ─────────────────────────────────────────────
"Plugin" (dsh-workspace-core …)    A Cordis plugin = an npm package @deepseek-ai/dsh-<name>
                                   whose module exports name/inject/apply/Config, OR a
                                   Service subclass. (packages/<group>/<pkg>/)
"Bundle" (one-enable everything)   A bundle package shipping a `cordis.patch.yml` layer,
                                   declared via the `dsh.bundle.patch` manifest field and
                                   composed by a profile's `dsh.profile.bundles` list.
"Profile"                          TWO things:
                                     (a) a deployment "profile" (HOST plane) = a directory
                                         composing bundles + the user's `cordis.patch.yml`;
                                     (b) an "agent preset" (AGENT plane) = agent.cordis.yml
                                         mounted once, joined by sessions.
"Service" (ctx.notes / ctx.tasks)  A Cordis service = a named ctx.<key>, declared by
                                   TypeScript `interface Context` merging, consumed via
                                   `inject: [...]` or `ctx.get(...)`. Exactly the pattern
                                   PKW §49 demands (no `import { NotesServiceImpl }`).
"Event Bus"                        Typed Cordis events (interface Events merging) with 5
                                   dispatch modes. NOTE: these are in-process signals, not
                                   a durable queryable log (§5).
"Tool Registry"                    ctx.tools.register(defineTool({…})) — a guarded pipeline.
"MCP Client"                       @deepseek-ai/dsh-mcp-client (reuse it, do not write one).
"Web Extension"                    A Client package (dsh.client rows → window.__DSH_BOOT__)
                                   registering Slots; Host methods exposed via @Remote.
```

The practical consequence: **PKW is not "one bundle of 12 plugins."** It is a set of
domain **packages** (each providing a service or tool), composed as (a) a **host-plane bundle**
for durable cross-session services, and (b) an **agent-preset** for the model-facing tools and
persona. Details in §15–§16.

---

## 1. Composition planes (the correct mental model)

Three layers, bottom-up:

### 1.1 Bundle package (`packages/bundle/*`)
A bundle is an npm package whose only substance is a patch layer:

```jsonc
// package.json excerpt (see packages/bundle/base/package.json)
{
  "name": "@deepseek-ai/dsh-base",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Its `cordis.patch.yml` is a list of `insert:` / id-targeted `config:` / `disabled:` patches applied
as ONE layer over an empty root. The base bundle (`packages/bundle/base/cordis.patch.yml`) inserts
`timer`, `hmr`, `llm`, `session`, `typert*`, `agent`, `agent-default-model`, `jobs`, `settings`,
`tools`, `system-prompt`, `sandbox*`, `approval`, `fs*`, `storage*`, the subagent providers, etc. —
the shared core of every profile. `@deepseek-ai/dsh-web-app` layers the browser surface on top
(`webserver`, `connection`, `clientModules`, the `dsh.client` UI roster). A patch **replaces a
row's whole `config`**, never deep-merges.

### 1.2 Profile (HOST plane) — `packages/boot/app-boot/src/profile.ts`
A profile is a directory `$DSH_HOME/profiles/<name>/` holding `package.json` (with
`dsh.profile.bundles`) and a `cordis.patch.yml` (the user's own layer, applied last):

```jsonc
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
```

Composition order: each bundle's patch list in `bundles` order → the profile's own patch → launcher
`--patch` overlays and flag-derived patches. `PROFILE_TEMPLATES` pre-defines `web` and `headless`.
This is what the standard preset's header loosely calls "the host composition (`base.cordis.yml` +
`web.cordis.yml`)" — the real mechanism is bundle patches composed by the profile.

### 1.3 Agent preset (AGENT plane) — `apps/cli/config/agent-presets/*`
A preset is a directory with `agent.cordis.yml` + `preset.yml`:

```yaml
# preset.yml (display metadata only)
name: 标准模式
description: 功能完整的编码 Agent …
order: 1
```

`agent.cordis.yml` is a list of rows contributing **what one session adds to the host registries**:
persona, prompt sections, tool rows, and (behind `isolate` realms) preset-owned services. It is
mounted ONCE under a standing scope; every session naming it joins by scope parentage. The roster
service `ctx.agentPresets` owns discovery/authoring/mounting (`list/read/copy/standingKeyFor`).

**Plane rule (critical):** the registries themselves (`tools`, `systemPrompt`, `agents`,
`agent-loop`, `sessions`), anything crossing sessions (persistence, storage, sandbox, approval,
model route, subagent registry), credentials, settings — belong to the **host** plane (bundle/profile).
A preset contributes the model-facing tools and persona. A service a preset owns **must** sit inside
a `cordis:group` with an `isolate` realm, or the mount is rejected (process-global service collision).

---

## 2. Plugin minimal example

Three accepted shapes (`docs/cordis-tutorial/01-first-plugin.md`, `03-services.md`):

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

// 1. Function plugin (most common): optional name/inject/Config exports.
export const name = 'hello'
export function apply(ctx: Context) {
  console.log('hello from my first plugin')
}

// 2. Object plugin.
export const objectPlugin = { name: 'object-plugin', apply(ctx: Context) {} }

// 3. Class plugin: a Service subclass (used when exposing a service).
export class MyService extends Service {
  constructor(ctx: Context) { super(ctx, 'myService') }
}
```

Composed by a `cordis.yml` list of entries; `name` is a module specifier (relative path or npm
package). Entries start concurrently — load order comes from service dependencies, not file position:

```yaml
- name: './hello.ts'
- name: '@deepseek-ai/dsh-tools'
```

Loader metadata: `id` (stable identity for HMR diffing), `name`, `config`, `disabled`,
`inject` (rarely set at the row level). `disabled: !!js …` gates a row at mount decision time.
Config entry metadata beyond `name`/`config`/`disabled` stays literal.

---

## 3. Service registration (how `ctx.notes` becomes real)

A service is a named capability in a flat per-application namespace. Two parts
(`docs/cordis-tutorial/03-services.md`):

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context { greeter: GreeterService }   // ← compile-time: makes ctx.greeter typecheck
}

export class GreeterService extends Service {
  constructor(ctx: Context) { super(ctx, 'greeter') }  // ← runtime: registers under 'greeter'
  greet(who: string) { return `Hello, ${who}!` }
}

export const name = 'greeter'
export function apply(ctx: Context) { ctx.plugin(GreeterService) }
```

- `super(ctx, 'greeter')` registers the instance; unloading the provider removes it (registrations
  are effects).
- `ctx.plugin(ServiceSubclass)` mounts it like any plugin; it returns a **fiber** handle.
- `ctx.provide(name, value)` is the lower-level registration verb (`provide()` throws on a second
  registration under the same realm symbol).
- **Naming**: the harness claims plain names (`tools`, `llm`, `agents`, `fs`, `storage`, `skills`,
  `web`, `jobs`, `subagents`, …). PKW services must be namespaced/distinct (e.g. `pkwNotes`,
  `pkwTasks`) or they collide with the harness's own flat namespace.

The authoritative catalog of every registered service (owner, role, implementations, consumers) is
`docs/capability-seams.md` (generated) and the `cordis-surface` regions on `docs/subsystems/*`.

---

## 4. Plugin dependency injection

Exactly PKW §49. `docs/cordis-tutorial/03-services.md`:

- **Hard dependency** → `export const inject = ['tools']`; the plugin stays PENDING until every
  listed service exists; inside `apply`, `ctx.tools` is guaranteed. Dependency is tracked after
  load — if a required service disappears, dependents unload and reload when it returns.
- **Optional dependency** → skip `inject`, probe `const t = ctx.get('tools')` and handle
  `undefined`.

```ts
export const name = 'greet-tool'
export const inject = ['tools']
export function apply(ctx: Context) { ctx.tools.register(/* … */) }
```

A plugin whose `inject` names a service nobody provides sits PENDING forever (silent; diagnose via
fiber state `FiberState.PENDING`). "Provider unknown at load" is a loud failure only when config is
invalid or `apply` throws (`FAILED`).

---

## 5. Event API (typed events + the durability caveat)

Typed events via declaration merging (`docs/cordis-tutorial/04-events.md`):

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'stats/report'(name: string, count: number): void
  }
}
```

Listen: `ctx.on('stats/report', (name, count) => { … })` — an effect, removed on unload.
Dispatch — **five modes**, each part of the event's public contract:

| Mode | Call | Semantics |
|---|---|---|
| `emit` | `ctx.emit(name, ...args)` | sync broadcast, returns not collected |
| `parallel` | `await ctx.parallel(name, ...args)` | all listeners concurrently, awaited together |
| `serial` | `await ctx.serial(name, ...args)` | in order; first non-null/false/undefined return wins |
| `bail` | `ctx.bail(name, ...args)` | synchronous serial |
| `waterfall` | `ctx.waterfall(name, ...args, next)` | around-middleware; **listener MUST call `next()`** to delegate, returning without it short-circuits |

Harness examples: `agent/request` (waterfall — replace model-call config), `approval/request`
(waterfall — policy answers instead of the user), `tools/pre-execute`, `tools/execute`,
`tools/post-execute` (waterfalls), `tools/result` (emit). New harness events document their mode with
an `@mode` JSDoc tag.

**Critical caveat for PKW §5:** Cordis events are **in-process typed signals**, not a durable,
queryable log. PKW wants to answer "who created this task?" / "why did this fact change?" — that
requires a **durable event store**, which is a different facility than `ctx.emit`. See §14 (the
`storage`/`storageDomain` seam) and §16. PKW's `DomainEvent` (id/aggregate/actor/correlationId/
beforeRevision/afterRevision) is a *domain data record*, not a Cordis event payload. The two combine:
a mutation writes the durable domain event **and** emits a Cordis signal for live listeners
(e.g. `note.updated` → sync worker).

---

## 6. Config schema

Each plugin declares a **Schemastery** schema (`docs/cordis-tutorial/05-config.md`); Cordis accepts
any Standard Schema validator, but a plain object does not work:

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config { greeting: string; targets: string[] }
export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  targets: Schema.array(String).default(['world']),
})

export function apply(ctx: Context, config: Config) { /* config is complete + validated */ }
```

Configured in `cordis.yml`:

```yaml
- name: './config-demo.ts'
  config:
    targets: ['alpha', 'beta']
```

- Invalid config fails the load with a precise `ValidationError` (the plugin never starts
  half-configured).
- **Computed values** use `!!js` (never `!js`), valid only inside `config` and an entry's
  `disabled` field; interpolates against the plugin context (so `ctx.<service>` is reachable there):

```yaml
- id: webserver
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
- id: tool-bash
  disabled: !!js process.platform === 'win32'
```

- Environment variables are read as `!!js process.env.WEKNORA_API_KEY` (the harness convention),
  or through `ctx.credentials` / `ctx.settings` for secret/configuration management (§14). The
  PKW design's `${env:…}` syntax does not exist — use `!!js process.env.…`.
- The full deployment-axis config reference is the generated `docs/config-catalog.md`
  (`pnpm run gen-config-catalog`), which cross-checks each schema against the declared `Config` type.

---

## 7. Bundle schema

Bundle = npm package declaring `dsh.bundle.patch` (→ a `cordis.patch.yml`). The patch vocabulary
(`packages/bundle/base/cordis.patch.yml`, `packages/bundle/web-app/cordis.patch.yml`):

```yaml
# One insert layer over the empty root:
- insert:
    - id: llm
      name: '@deepseek-ai/dsh-llm'
    - id: tools
      name: '@deepseek-ai/dsh-tools'

# Id-targeted override (replaces the WHOLE config of the row, not merged):
- id: system-prompt
  config: { persona: "You are a coding agent… {{model}} … {{cwd}}." }
- id: hmr
  disabled: true
```

Group rows (`cordis:group`) nest a sub-list that loads/unloads as one unit, and `isolate` gives a
group its own instance of a service name:

```yaml
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true            # entry-local realm for a preset-owned service
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config: { section: "…" }
```

`isolate: true` = a realm private to each mounting session; a string label joins subtrees into one
shared realm (but does NOT pool instances — `provide()` throws on the second registration under the
same symbol). This is the only place a **preset-owned** service may live.

The PKW "bundle" (`knowledge-workspace` with 12 sub-plugins) should therefore be expressed as one
or more DSH bundles (host-plane services) **plus** a preset (agent tools). A DSH bundle must not
contain business logic either — it is a pure patch layer, which matches PKW §48's intent.

---

## 8. Profile schema (and the agent preset)

Two schemas, both small.

**Profile manifest** (`packages/boot/app-boot/src/profile.ts`):

```ts
interface DshProfileManifest { bundles?: string[] }   // ordered bundle package names
interface DshBundleManifest { patch: string }          // path to cordis.patch.yml
interface DshManifestSection { bundle?: DshBundleManifest; profile?: DshProfileManifest }
```

Directory: `$DSH_HOME/profiles/<name>/` with `package.json` (above) + `cordis.patch.yml` (user
layer) + `pnpm-workspace.yaml` (hoisted linker for out-of-tree plugins). `dsh plugin --profile <name>
add <pkg>` manages it; module resolution is two-anchor (installation first, then the profile dir).

**Agent preset** (`apps/cli/config/agent-presets/*/`): `agent.cordis.yml` (plugin rows) +
`preset.yml` (`name`, `description`, `order`). Authored presets live under
`${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`; the shipped set (`standard`, `code`, `minimal`,
`cordis`) is off-limits — copy it and edit the copy. Mount-validate with `ctx.agentPresets.standingKeyFor(id)`.

---

## 9. Tool registration API

`docs/cordis-tutorial/07-into-the-harness.md` is the canonical minimal example:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet the named person.',
    parameters: {
      name: { type: 'string', required: true, description: 'Who to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) { return `Hello, ${args.name}!` },
  }))
}
```

- `ctx.tools.register(...)` returns a disposer attached to the plugin — unload unregisters the tool.
- `defineTool` converts `parameters` to the JSON Schema the model sees, infers `args` types, and
  validates model-supplied arguments before `execute`.
- `output.schema` declares the canonical value; `output.render` separately produces the durable
  result content (pure function of `args`).
- `ctx.tools` is the "Tool registry and guarded execution pipeline" (`packages/core/tools`).
- Tool presentation/render intent (`generic`/`terminal`/`diff`, `locations`) is decided up front
  (`docs/cookbook/adding-a-tool.md`).

**Execution pipeline** (`docs/tool-execution-pipeline.md`), so PKW approval tiers (§37) can be
implemented as policy rather than per-tool code:

```text
tools/pre-execute (waterfall: hooks/permission/sandbox)
  → monotonic guards (deny|abstain) → ctx.approval (one-shot ask)
  → tools/execute (waterfall: timeout/retry/metrics) → tool body
  → tools/post-execute (waterfall: accept/block/replace/add context)
  → normalize → finalizeContent → tools/result (emit)
```

`ctx.approval` is the seam PKW §37's risk-tiered write approvals should drive; `ctx.sandboxPolicy`
holds the deployment default mode + workspace root. Model-callable tools list lives in
`docs/tool-catalog.md`; `ctx.systemPrompt` assembles prompt sections + tool schemas per step.

---

## 10. Web extension API

The browser is a **client plugin graph** composed by `ctx.clientModules` (`packages/client/modules`)
and booted as `window.__DSH_BOOT__`. Two extension mechanisms exist, for two different lifetimes:

**(a) Persistent client package** — a `packages/client/*` package that declares `dsh.client` in
`package.json`, exports `./client`, and uses the shared tsdown preset
(`packages/client/tsdown.client.ts`); a `dsh.client` row in the web-app bundle is the "browser roster"
the modules node half scans (e.g. `ui-theme`, `ui-layout`, `ui-sidebar`, `ui-settings`, `connection`,
`client-runtime`). UI is registered into **Slots** (queried live via the `slots` service; registration
protocols are `single`/`list`/`keyed`/`chain`). Host↔Client for persistent packages uses the Typert
gateway: a Host service marks methods `@Remote` / `@RemoteScope`, the Host build generates the
Client projection, and the Client loads it under `ctx.remote` (see `docs/development.md` §"TypeScript
project layout" and `docs/api-gateway.md`).

**(b) Dynamic Cordis Plugin** (session-scoped, this GUI's `cordis_define`/`cordis_run`) — a
package-private RPC (`harness.handle('method', handler)` on Host, `host.call('method', args)` on
Client), Client UI registered in queried Slots, React via `React.createElement` (no JSX/TS/import),
Host/Client code as plain-JS function bodies. This is for **temporary runtime extensions**, not the
shipped PKW UI.

For PKW's Web UI (Phase 7) the intended path is **(a)**: a client package registering Notes/Tasks/
Knowledge/Activity views into the appropriate Slots, with Host domain services exposed via `@Remote`.

---

## 11. MCP integration API

Reuse `@deepseek-ai/dsh-mcp-client` (`packages/mcp/mcp-client`) — **do not write a new MCP runtime**.
It connects to external MCP servers and registers their tools on `ctx.tools` as
`mcp__<serverName>__<rawName>`. One plugin instance per server:

```yaml
- id: mcp-weknora
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: weknora
    transport: streamable-http
    url: !!js process.env.WEKNORA_BASE_URL + '/mcp'
    headers:
      Authorization: !!js '`Bearer ${process.env.WEKNORA_API_KEY}`'
    toolCallTimeoutMs: 60000
    reconnect: { enabled: true, maxAttempts: 10 }
```

Config: `transport` (`stdio`|`streamable-http`), `serverName`, `command/args/env/cwd` (stdio) or
`url/headers` (http), `toolCallTimeoutMs`, `failOnStartupError`, `reconnect.*` (exponential backoff,
per-outage budget). Services consumed: `ctx.tools` only. Public tool names are a pure function of
`(serverName, rawName)`; a duplicate `serverName` fails the later instance at load.

This directly implements PKW §23: the official WeKnora MCP is the **read-only Query Plane**
(`mcp__weknora__*` tools). The **Mutation Plane** (upload/update/delete/reparse for sync) still
needs a REST-based provider — MCP is deliberately read-only, exactly as PKW §23 notes.

---

## 12. Testing pattern

`docs/testing.md` + `docs/AGENTS.md`:

- **Unit** (`pnpm run test`): vitest, specs under `tests/**` beside the code; every registry gets an
  HMR-safety test (dispose the fiber, assert cleanup). Prefer edge cases, error paths, event ordering,
  concurrency races.
- **Coverage gate** (`pnpm run test:coverage`): per-file **100%** on `packages/*/*/src` — this is the
  CI gate, not `test`.
- **Real-API e2e** (`pnpm run test:e2e`): with-key against live providers; self-skips without its key.
  PKW's WeKnora e2e belongs here (self-skip without `WEKNORA_API_KEY`), with a **Fake WeKnora**
  (HTTP contract stub) for the offline/recovery cases PKW §59–§60 require.
- **Snapshot** (`pnpm run test:snapshot`): keyless expected outputs over a real runnable example;
  record with `:record`. Web browser snapshots (`pnpm run test:web`) use Chromium.
- **"Real entry path"**: product-visible plugins need a REAL-composition test (boot a test-only
  `cordis.yml` through the Loader), not a hand-built `ctx.plugin` suite. Test helpers live in
  `packages/test-support` (e.g. `makeBridgeHarness`, the `dsh-acp-snapshot` suite factory).

For PKW: unit-test Markdown frontmatter/parser, path safety, task state machine, fact lifecycle,
outbox retry math, hash/idempotency; e2e-test against a Fake WeKnora (200/400/401/404/409/429/500/
timeout/slow); add a crash-recovery test (write note → "crash" → restart → outbox drains).

---

## 13. Packaging pattern

`docs/cookbook/adding-a-package.md` + root `AGENTS.md`:

- Package: `packages/<group>/<pkg>/` = `@deepseek-ai/dsh-<name>`. Client plugins are
  `@deepseek-ai/dsh-client-<name>` under `packages/client/*`; host-side helpers use
  `@deepseek-ai/dsh-host-*`. `"type": "module"`,
  `main: "lib/index.js"`, `types: "lib/types/index.d.ts"`, `exports["."]` with `types`/`default`,
  `@deepseek-ai/cordis` in BOTH `peerDependencies` and `devDependencies`, mirror each dsh peer in
  devDeps, `@deepseek-ai/schemastery` in `dependencies` (runtime validator). `files` = exactly
  `lib/index.js`, `lib/invariant.js`, `lib/types/**/*.d.ts` (+ runtime artifacts).
- Group by role: `core`, `api`, `llm`, `shell`, `subprocess`, `terminal`, `fs`, `skill`, `web`,
  `compaction`, `context`, `subagent`, `bundle`, `workflow`, `todo`, `plan`, `preset`, `guard`,
  `session`, `settings`, `credentials`, `interaction`, `boot`, `support`, `util`. New group allowed
  but is a pure container (no package.json, packages one level below).
- tsconfig: each package `extends ../../../tsconfig.base.json`; register in **exactly one** aggregate —
  `tsconfig.host.json` (Host) or `tsconfig.client.json` (Client). Never both (the `Context` interface
  merge collides in one program). Client packages extend `tsconfig.base.client.json`.
- Build (`pnpm run build`): `tsc -b tsconfig.host.json` → `tsdown --env.DSH_BUILD_FACE host` →
  `tsc -b tsconfig.client.json` → `tsdown --env.DSH_BUILD_FACE client` → `pnpm run build:web`.
- Gates: `pnpm run constraints && pnpm run typecheck && pnpm run lint`; `pnpm run build &&
  pnpm run hygiene` (knip + publint + workspace constraints + NodeNext consumer check);
  `pnpm run doc-sync`.
- Conventions: ESM everywhere; `.ts` in local relative imports; branded ids (`Branded<B>` from
  `dsh-brand`) for opaque ids; "registrations are effects"; "misconfiguration fails loud"; a
  capability seam = Service Definition / Provider / Consumer roles, split only when they evolve
  independently.

---

## 14. Existing seams PKW must reuse (do NOT reimplement)

From `docs/capability-seams.md` (generated) — the harness already ships these, each with a
`ctx.<key>`:

| PKW need | Existing harness seam | Notes |
|---|---|---|
| Local files (notes .md) | `ctx.fs` (`fs-local` / `fs-sandbox` / `fs-e2b`) | path safety + workspace root enforced by `ctx.sandboxPolicy`; `tool-fs` already exposes read/write/edit |
| SQLite (tasks/facts/index/events) | `ctx.storage` (+ `storage-sqlite` backend), `ctx.storageDomain` | typed durable KV/domain data; `session-persistence-sqlite`/`session-query-sqlite` show the sqlite pattern |
| Binary attachments | `ctx.attachments` (`attachment-local`) | durable binary attachment storage; host commits accepted images |
| Workspace identity | `ctx.workspaceRegistry` | WorkspaceId-branded records |
| Credentials (WeKnora key) | `ctx.credentials` (`credentials-local`, env/.env) | value-free views, write-only storage |
| Settings/config | `ctx.settings` (`settings-file`) | namespace schemas + layered values |
| Web search/fetch (PKW §33 "General Research") | `ctx.web` (`web-search-*`, `web-fetch-http`) + `tool-web` | reuse for Web search, do not build |
| HTTP routes (PKW §43 REST) | `ctx.webServer` (route registration) + `ctx.apiProxy`/`api-gateway` | transport-agnostic host gateway |
| Model tools | `ctx.tools` (+ `defineTool`) | §9 |
| Prompt/persona | `ctx.systemPrompt`, `@deepseek-ai/dsh-persona` | §9 |
| Skills | `ctx.skills` (`skill-filesystem`, `tool-skill`) | for PKW's own operator skills |
| Subagents/workflows | `ctx.subagents`, `ctx.workflowEngine` | fan-out, Ralph loops |
| Background jobs | `ctx.jobs` | outbox/sync workers can register here or use `ctx.effect` timers |
| Logging/tracing | Cordis logger service; `ctx.sessionTelemetry`; correlation via `CallId`/branded ids | PKW §63 trace/correlation |

**Key implication for PKW §44–§45:** do not add `better-sqlite3` as a raw dependency. Use the
`ctx.storage` seam with the `storage-sqlite` backend (single `workspace.sqlite` as PKW §44 wants), or
`ctx.storageDomain` for typed domain records. Similarly use `ctx.fs` (not raw `node:fs`) so the
sandbox policy applies, and `ctx.attachments` (not a bespoke attachment store). This is the single
largest "don't rebuild" saving in the whole PKW design.

---

## 15. What PKW's 12 plugins become in DSH terms

PKW's flat list of 12 plugins maps to a seam-aware shape (Service Definition / Provider / Consumer):

| PKW plugin | DSH artifact | Plane |
|---|---|---|
| `workspace-core` | largely subsumed by existing `ctx.fs` + `ctx.workspaceRegistry` + `ctx.storage`; a thin `pkw` root/config service if needed | Host |
| `events` | a durable event store over `ctx.storage`/`storageDomain` + typed Cordis events (`pkw/note.updated`, …) for live listeners | Host |
| `notes` | `dsh-pkw-notes` (service `ctx.pkwNotes`) over `ctx.fs` + frontmatter/gray-matter + notes_index in storage; file watcher via `chokidar`/`ctx.effect` | Host |
| `attachments` | build on `ctx.attachments` (+ a link table for note↔attachment) | Host |
| `tasks` | `dsh-pkw-tasks` (service `ctx.pkwTasks`) over `ctx.storage` | Host |
| `facts` | `dsh-pkw-facts` (proposition store over `ctx.storage`), lifecycle = domain state machine | Host |
| `relations` | `dsh-pkw-relations` (link table over `ctx.storage`) | Host |
| `weknora` | `dsh-pkw-weknora`: Service Definition `ctx.weknora` + a REST provider; reuse `dsh-mcp-client` for the read plane | Host |
| `weknora-sync` | `dsh-pkw-weknora-sync`: a consumer listening to `pkw/*` events, outbox + sync_records over `ctx.storage`, calls `ctx.weknora` | Host |
| `context-compiler` | `dsh-pkw-context` (service `ctx.pkwContext.compile`) — could be Host or preset-owned | either |
| `workspace-api` | `@Remote`-marked Host methods → `ctx.remote` (Typert), plus `ctx.webServer` routes | Host + Client |
| `workspace-web` | a `packages/client/*` package (`dsh.client` row) registering Slots | Client |

The model-facing tools (`notes.*`, `tasks.*`, `facts.*`, `knowledge.search`, `context.compile` — PKW
§36) are separate tool rows in the **preset** (`ctx.tools.register`), consuming the host services.
The approval tiers (PKW §37) are `ctx.approval` policy / `tools/pre-execute` waterfall listeners /
monotonic guards — not scattered `if` checks in every tool.

---

## 16. Two-planes decision for PKW (the structural correction)

The PKW design's "everything is one bundle" assumption is the main thing to fix. Apply the harness's
plane rule:

- **HOST plane (bundle/profile):** everything durable and cross-session — the workspace root/config,
  the domain stores (notes index, tasks, facts, relations, events, outbox, sync_records), the
  WeKnora client service + sync worker, credentials/settings, the REST routes, and the durable
  storage backend. These are shared across sessions and must be registered once.
- **AGENT plane (preset):** the model-facing tools (`notes.list/get/create/…`, `tasks.*`, `facts.*`,
  `knowledge.search`, `context.compile`), the persona/prompt section, and (behind an `isolate` realm)
  any genuinely per-agent service like the context compiler if it must be per-session.

This satisfies PKW §68's "install only Notes + Tasks" requirement cleanly: **capability selection =
which host bundle layers and which preset tool rows are composed**, never source edits.

---

## 17. Corrections to the PKW design document

1. **`${env:VAR}` config syntax does not exist** — use `!!js process.env.VAR` (or `ctx.credentials`
   for secrets, `ctx.settings` for hot-reloadable config). (§47)
2. **`better-sqlite3` / `chokidar` / `gray-matter` / `fast-glob` / `mime-types`:** `better-sqlite3`
   should be dropped in favor of `ctx.storage`+`storage-sqlite`; the others are acceptable as
   package `dependencies` but the file I/O itself goes through `ctx.fs`. `zod` is already the repo's
   validation dependency (schemastery for config schemas, zod for domain data), so PKW §45's zod is
   consistent with repo convention. (§44–§45)
3. **`unified`/`remark-*`:** fine as dependencies for robust Markdown parsing (PKW §45's own advice
   against regex is correct). For editor/rendering, `react-markdown`/`remark-gfm`/`rehype-sanitize`
   and CodeMirror 6 are the right choices for the Client package.
4. **"Domain events" ≠ Cordis events** (§5) — model them as durable records + Cordis signals.
5. **"Bundle" must be split into bundle (host) + preset (agent)** (§16) — this is what makes the
   "no `import { NotesServiceImpl }`" rule (§49) and the "swap WeKnora/Task backend" requirement
   actually achievable, since providers are selected by composition, not by imports.
6. **"Model-visible ⟺ logged"** (repo invariant, root `AGENTS.md`): anything that reaches a model
   request must be reconstructable from the session log. PKW's `context-compiler` output and any
   tool that injects context into the agent are model-visible, so each must be represented by a
   `SessionEvent` — a constraint PKW §35–§36 did not state but must satisfy. This is also why PKW
   should favor logging the *compiled context* (or its provenance) rather than raw store reads.

---

## 18. Phase-0 gate verdict

The harness's plugin system is fully characterized. PKW can be built on it **without** reimplementing
filesystem, SQLite storage, attachments, credentials, settings, web search, MCP, tool registry, or
approval. The next phases should be replanned around: domain **packages** (services), a **host bundle**
for durable services, and an **agent preset** for tools — not a single monolithic bundle.

No business plugin has been written. Proceeding to Phase 1 (domain model + workspace) is now
unblocked by this report.
