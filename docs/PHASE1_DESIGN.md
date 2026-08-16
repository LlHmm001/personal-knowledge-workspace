# Phase 1 设计 — 领域基础 · workspace-core · 持久化事件

> 项目：Personal Knowledge Workspace（PKW）
> 门禁：Phase 0 适配结论（`docs/HARNESS_ADAPTER_REPORT.md`）是唯一事实源；原 PKW 文档中与之冲突的部分一律不实现。
> 范围：**仅领域基础 + workspace-core + 持久化事件**。不做 Tasks、Facts、WeKnora、Agent Tools、Web UI、Context Compiler。

---

## 1. 三交付面与依赖边界（决定 #1 / #8）

三个面，依赖单向。Phase 1 只交付 **Host**。

```text
CLIENT（浏览器）       AGENT（preset）        HOST（bundle/profile）
─────────────────     ──────────────        ──────────────────────────
（Phase 1 无）          （Phase 1 无）          storage + storage-sqlite
                                               storage-domain（backend: sqlite）
                                               workspace（ctx.workspaceRegistry）
                                               dsh-pkw-events      （ctx.pkwEvents）
                                               dsh-pkw-workspace   （ctx.pkwWorkspace）
```

依赖不变量（锁定）：

```text
Agent  → Host
Client → Host

Host -X→ Agent
Host -X→ Client
```

- Host 不依赖 Agent 或 Client。Phase 1 任何包不得 import `dsh-tool-*`、`dsh-client-*`、`dsh-agent-*`、`dsh-system-prompt`，或任何 agent/浏览器向的代码。领域服务不知道 LLM、工具、prompt 组装、Slot 的存在。
- Agent 与 Client 是 Host 服务未来的**消费者**，在后续 phase 以新行/新包加入，绝不作为这些包的 import。
- 编译期隔离沿用仓库的 Host/Client 聚合：Phase 1 每个包只登记进 `tsconfig.host.json`。

---

## 2. 复用的 Harness seam（决定 #2）

PKW 不拥有文件系统、不拥有 SQLite 驱动、不拥有 workspace 注册表。它组合已存在的 seam：

| 关注点 | Harness seam | Phase 1 用法 |
|---|---|---|
| Workspace 身份 / 注册 / 打开 | `ctx.workspaceRegistry`（`@deepseek-ai/dsh-workspace`） | register/open/list/resolve-by-path；PKW 不复刻 workspace 记录 |
| 文件操作 | `ctx.fs`（`FileSystem`） | `resolve`、`contains`、`readText`、`writeText`、`editText`、`listDir`、`stat` |
| 路径安全原语 | `ctx.fs.contains(parent, child)` | **唯一**的包含性判断——规范化、symlink 安全，不做 `../` 字符串拼接 |
| 持久化状态 | `ctx.storage` + `ctx.storageDomain` + `@deepseek-ai/dsh-storage-sqlite` | 单个 `pkw` domain，路由到 backend `sqlite` |
| 标识符 | `@deepseek-ai/dsh-brand`（`Branded<B>`） | `NoteId`/`AttachmentId`/`EventId`/`OperationId`/`CorrelationId`；复用 `WorkspaceId` |

Phase 1 所有包禁止（设计层面强制）：

- `node:fs`/`node:fs/promises` —— 文件 I/O 只走 `ctx.fs`。
- `better-sqlite3`（或任何第三方 SQLite 驱动）—— 持久化只走 `ctx.storage`/`storageDomain`，其 `storage-sqlite` backend 用的是内置 `node:sqlite`。
- 跨 PKW 包 import 实现类（决定 #12）—— 服务只经 `ctx.<key>` 获取。

SQLite 说明：`@deepseek-ai/dsh-storage-sqlite` 注册为 backend **`sqlite`**（`packages/storage/storage-sqlite/src/index.ts:158-168`），配置 `path`（测试用 `:memory:`）+ `journalMode`。其契约是**逐语句原子性**（`packages/storage/storage-sqlite/README.md`）——没有跨记录事务。这是 §7 提交契约的基础。

---

## 3. 稳定标识符与 id ≠ path（决定 #3）

五个不透明、带品牌的标识符（严格沿用 `packages/workspace/workspace/src/types.ts` 的模式）：

```ts
import type { Branded } from '@deepseek-ai/dsh-brand'

export type WorkspaceId  = Branded<'WorkspaceId'>   // 复用 @deepseek-ai/dsh-workspace，不重复声明
export type NoteId       = Branded<'NoteId'>
export type AttachmentId = Branded<'AttachmentId'>
export type EventId      = Branded<'EventId'>
export type OperationId  = Branded<'OperationId'>
export type CorrelationId = Branded<'CorrelationId'>

// 工厂：生成的 uuid，绝不来自用户输入、绝不来自路径。
function NoteId(id: string): NoteId { return id as NoteId }              // NoteId(randomUUID())
function AttachmentId(id: string): AttachmentId { return id as AttachmentId }
function EventId(id: string): EventId { return id as EventId }
function OperationId(id: string): OperationId { return id as OperationId }
function CorrelationId(id: string): CorrelationId { return id as CorrelationId }
```

锁定规则：

- **对象身份 ≠ 文件路径。** `NoteId` 是生成后不变的 uuid；笔记位置是独立、可变的 `path` 字段。移动 `工作/A.md → 研究/A.md` 只改 `path`，所有以 `NoteId` 为键的引用（tasks、facts、attachment relation、WeKnora 映射）不失效。
- **`AttachmentId` 是独立稳定 id**，绝不由 NoteId 派生（§10）。
- 三个 id 的语义（决定 #2）：
  - `OperationId` = **一次具体的领域操作**（一个 `OperationCommit` 的键）。
  - `CorrelationId` = **一条跨服务/业务流**（跨多个操作）。
  - `EventId` = **一条持久化领域事件**。
- 持久化边界上，品牌擦除为 `z.string().transform(v => v as XId)`（与 `packages/workspace/workspace/src/spec.ts:14` 相同；品牌无运行时表示）。

---

## 4. OperationContext（决定 #2）

归一化后的形态（`newOperationContext` 之后保证完整）：

```ts
export type ActorType = 'user' | 'agent' | 'system' | 'sync'
export interface Actor { type: ActorType; id?: string }

export interface OperationContext {
  workspaceId: WorkspaceId
  actor: Actor
  operationId: OperationId      // 始终生成；一次具体操作
  correlationId: CorrelationId  // 始终存在；输入边界可省略，省略即生成
  causationId?: string          // 触发本操作的前序 eventId（可选）
}
```

- **输入边界**是唯一允许省略 `correlationId` 的地方；工厂总是生成 `operationId` 与（缺省时的）`correlationId`：

```ts
newOperationContext(actor: Actor, opts?: { correlationId?: CorrelationId; causationId?: string }): OperationContext
```

- `OperationContext` 是身份在变异路径上的**显式**线程。Phase 1 作为普通参数显式传递（不做 ambient async-local）；未来 agent 层可把 harness 的 `CallId`/会话相关 id 填入 `correlationId`。
- 工厂由 `pkwWorkspace.forWorkspace(id)` 提供，负责盖 `workspaceId`，使调用方无法伪造与提交不一致的 workspace。

---

## 5. 持久化事件 vs Cordis 信号（决定 #4）

两个机制，绝不混用：

- **持久化领域事件** —— 以 `OperationCommit` 形式写入 `pkw` domain 的 `commits` 表（经 `ctx.storageDomain`，由 `storage-sqlite` 持久化）。它是**审计历史**：重启后可查询，是“谁做了什么、为什么、什么顺序”的唯一来源。
- **Cordis 事件 `pkw/event.committed`** —— 仅在持久化提交成功**之后**发出的进程内、同步、fire-and-forget 信号。携带最小实时投影（operationId、correlationId、workspaceId、event 元数据），供进程内监听者（未来的 sync worker）响应，**不是**审计日志。

生命周期（锁定）：

```text
领域操作成功
→ 持久化 OperationCommit
→ 持久化成功
→ emit Cordis `pkw/event.committed`
```

- Cordis 仅用于实时信号。**持久化提交失败 ⇒ 绝不发出 committed 信号。**
- 提交成功后、信号发出前崩溃是可接受的：事件已持久化（审计完整），信号只驱动尽力而为的响应（未来 sync worker 启动时 reconcile）。

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    pkwEvents: PkwEventStore
    pkwWorkspace: PkwWorkspace
  }
  interface Events {
    /** 提交后、进程内实时信号。@mode emit */
    'pkw/event.committed'(signal: PkwEventCommitted): void
  }
}

/** 实时信号的最小投影（非审计日志，不含 payload）。 */
export interface PkwEventCommitted {
  operationId: OperationId
  correlationId: CorrelationId
  workspaceId: WorkspaceId
  events: Array<{
    eventId: EventId
    type: string
    aggregateType: string
    aggregateId: string
    aggregateRevision: number
  }>
}
```

---

## 6. OperationCommit 与 DomainEvent（决定 #3 / #6）

**提交信封是持久化单元**（决定 #3）：

```ts
interface OperationCommit {
  operationId: OperationId        // 持久化键 / 幂等身份
  workspaceId: WorkspaceId
  actor: Actor
  correlationId: CorrelationId
  causationId?: string
  committedAt: string
  events: DomainEvent[]           // 1..N
}

interface DomainEvent {
  eventId: EventId
  type: string                    // 如 'note.created'（namespace/action）
  aggregateType: string           // 如 'note' | 'attachment' | 'workspace'
  aggregateId: string             // 不透明聚合 id（NoteId/AttachmentId/…，品牌擦除）
  aggregateRevision: number       // 该聚合历史中的第 N 个事件（计数器，非当前状态版本）
  createdAt: string               // ISO-8601，提交时打点
  payload: unknown                // 不透明 JSON；类型化 payload 由后续 phase 提供
}
```

- 一个操作（`OperationId`）可含 **1..N 个** `DomainEvent`，例如“移动笔记”同时产生 `note.moved` 与 `note.updated` 两条，且同属一个原子提交。
- 决定 #6 要求的字段（`workspaceId / type / aggregateType / aggregateId / aggregateRevision / actor / correlationId / causationId / createdAt / payload`）在查询展平时满足：查询服务返回**展平视图** `DomainEventView` = 信封字段（`workspaceId/actor/correlationId/causationId/operationId`）⊕ 事件字段（`eventId/type/aggregateType/aggregateId/aggregateRevision/createdAt/payload`）。信封字段对同一次操作的所有事件相同，故不在每条事件上冗余存储。

Domain spec（Phase 1 只声明用到的表；后续 phase 以 `version` 递增）：

```ts
export const pkwDomainSpec = defineDomain({
  name: 'pkw',      // 满足 UNIT_NAME_RE ^[a-z][a-z0-9_]*$
  version: 1,
  tables: {
    commits: domainTable<OperationId, OperationCommitRecord>(operationCommitRecord),
  },
})
```

- 无 `global` 单例；`commits` 表即权威。
- **预留、不在 Phase 1 声明**：`notes_index`、`attachments`、`tasks`、`task_note_links`、`propositions`、`relations`、`outbox`、`sync_records`、`context_snapshots`。各自在其 phase 以 `version` 递增加入（仓库的单调 `SCHEMA_VERSION`/`version` 语义：旧介质被拒绝，不做迁移）。

---

## 7. 提交契约（决定 #1 / #3 / #4 / #5）

### 7.1 不做全局事件溯源（决定 #1）

明确拒绝以下全局规则：

> ~~“state is a projection, never a second authoritative write”~~

替换为：

> **持久化 PKW 事件日志是「PKW 已观察操作」的权威历史，但它不是每个聚合当前状态的普遍权威。**

保留系统的单一事实源边界（不替 Notes / Tasks / Facts / Relations 在 Phase 1 做事件溯源决定）：

| 数据 | 权威事实源 |
|---|---|
| Markdown 笔记正文 | 文件系统 Markdown |
| 附件二进制 | workspace 文件 |
| Task 当前状态 | 未来的 Task Store（除非该 phase 自己显式选择事件溯源） |
| Fact/PLL 当前状态 | 未来的 Proposition Store（除非该 phase 自己显式选择别的模型） |
| 历史操作 | 持久化 Event Log |
| WeKnora | 仅检索投影（retrieval projection） |

### 7.2 原子提交 = 单个 OperationCommit 记录

Domain 层（`packages/storage/storage-domain/src/domain.ts`）保证**单记录原子写**（串行 per-domain 写链），`storage-sqlite` 保证逐语句原子性；**无跨记录事务**。因此：

> **一次提交 = 一次 `commits.put(operationId, commit)`**，把含 1..N 事件的整个 `OperationCommit` 作为一个 JSON 记录原子写入。

这带来（决定 #3）：

- **原子多事件提交** —— 借助存储层的单记录原子性。
- **持久化幂等** —— `operationId` 是持久化键，`commits.get(operationId)` O(1) 判断；**不需要在每次重启时从事件流重建完整 operationId 去重索引**。
- **无部分事件组** —— 一个 commit 要么整体落盘，要么整体不落。
- 事件查询服务可把 `OperationCommit.events` 展平成事件时间线。

`PkwEventStore.commit`（唯一写 `commits` 表的服务）：

```ts
interface DomainEventInput {
  type: string
  aggregateType: string
  aggregateId: string
  payload: unknown
}

interface CommitRequest {
  operationContext: OperationContext   // 含 operationId / correlationId
  events: DomainEventInput[]           // 1..N
}

async commit(req: CommitRequest): Promise<OperationCommit>
```

算法（服务自身的串行链，仿 `WorkspaceRegistry.enqueueOperation`）：

1. **校验**：`operationContext.operationId` 存在、`events` 非空、每条 `type/aggregateType/aggregateId` 非空。拒绝 ⇒ 无任何落盘、无信号。
2. **幂等**：`commits.get(operationId)` 已存在 ⇒ 返回既有 commit（不写、不信号）。
3. **打点**：为每条事件生成 `eventId = EventId(randomUUID())`、`aggregateRevision = cursor(aggType, aggId) + 1`、`createdAt = now`；组装 `OperationCommit`。
4. **提交**：`await commits.put(operationId, commit)` —— 单次原子持久化写。
5. **提交后（非权威）**：更新内存 revision cursor；`ctx.emit('pkw/event.committed', signal)`。
6. 返回 commit。

- **先提交，后信号**（决定 #4）。第 4 步失败 ⇒ 第 5、6 步不执行（“回滚”= 什么都没写）。第 5 步之后的失败 ⇒ 事件已持久化，失败被包含并记录，绝不回滚（与 domain 层 `emitChanged` 的“commit point has passed”纪律一致）。
- **幂等与重启**：幂等由 `operationId` 键的持久存在保证（O(1)），不需要全量去重重建。`aggregateRevision` 是内存计数器，启动时通过展平 `commits` 重建——它是廉价计数，**不是**幂等机制，也不承载“当前状态”语义（见 §7.1）。
- **强制经事件服务（决定 #5）**：所有变异型 PKW Host 服务对 `ctx.pkwEvents` 是**硬注入**，绝不静默绕过持久化历史（§12）。

### 7.3 未来文件型 Notes 的原子性（决定 #4）

对文件系统背书的 Notes，真正的「文件系统 + 存储」原子性**不可能**。不要用全局事件溯源去“解决”它。Phase 2 必须采用**文件系统原子写 + reconcile** 语义（先原子写 Markdown，再记录事件，启动时 reconcile 补账）。

---

## 8. ContextSnapshot / ContextSourceRef 预留（决定 #9）

只定义数据模型，不实现 Context Compiler、不持久化。它们用于满足 harness 不变量 **`model-visible ⟺ logged`**，且未来必须能指明「哪一版本/来源的 Note、Task、Fact、WeKnora chunk、Event 曾对模型可见」。

```ts
/** 一份被喂给模型的上下文的来源。 */
export interface ContextSourceRef {
  kind: 'note' | 'task' | 'fact' | 'knowledge' | 'event' | 'local-search'
  ref: string                 // NoteId/TaskId/PropositionId/knowledge id，或查询串
  revision?: number           // 读取时的 aggregateRevision（notes/tasks/facts）
  excerptHash?: string        // 实际交给模型的文本的 hash
}

/** 一次已编译上下文，按 correlation/operation id 键控。 */
export interface ContextSnapshot {
  id: string
  correlationId: string
  compiledAt: string
  sources: ContextSourceRef[]
  maxTokens: number
}
```

Phase 1 只声明类型并记录未来的 `context_snapshots` 表（随 compiler 落地以 `version` 递增加入）。暂不写入。

---

## 9. Note 与 Attachment 核心类型（决定 #9 / #10 / #7）

仅类型——用于验证 workspace 基础，**不实现** Notes 业务（索引、搜索、同步、编辑器）。Phase 1 不提供 Notes 服务。

```ts
/** 核心笔记类型：身份是 id；位置是可变的 path。 */
export interface Note {
  id: NoteId
  workspaceId: WorkspaceId
  path: string              // 相对 workspace 的 POSIX 路径，位于 <root>/notes/ —— 不是 id
  title: string
  revision: number          // 单调内容版本
  contentHash: string       // 规范内容的 sha256
  createdAt: string
  updatedAt: string
}

/** 核心附件类型：独立、稳定的 id（决定 #10）。 */
export interface Attachment {
  id: AttachmentId
  workspaceId: WorkspaceId
  filename: string
  mimeType: string
  sizeBytes: number
  sha256: string
  localPath: string         // 相对 workspace，位于 <root>/attachments/<attachmentId>/
  createdAt: string
}
```

决定 #10（已批准）：附件的物理归属以其**自身 `AttachmentId`** 为键，而非 NoteId：

```text
<root>/attachments/<attachmentId>/<filename>
```

`Note ↔ Attachment`（以及未来的 `Task/Fact ↔ Attachment`）是未来 **relations 层**建立的**关系**，绝不编码为附件的目录名。这明确反转了原 PKW §10（`attachments/<note-id>/`），使一个附件可被多个 note/task 引用而无需物理移动。

---

## 10. Workspace 布局与路径安全（决定 #6 / #7）

结构化 Host 状态由 harness 托管（**单个** SQLite DB，经 `dshHomePath`），**不放在 workspace 目录内**。workspace 文件保持可移植：

```text
<workspace root>/
  notes/                            # Markdown，保留用户任意目录结构
  attachments/<attachmentId>/       # 按 AttachmentId 为键（§10）
  archive/                          # 软删除目标（未来）
```

- **没有** `<root>/.system/workspace.sqlite`。结构化状态按 `workspaceId` 分区，存于 harness 托管的单库（决定 #6）。
- 未来如需完整 workspace 可移植，提供显式 export/import，打包「文件内容 + 结构化状态」。

`ctx.pkwWorkspace` 服务：

```ts
interface PkwWorkspace {
  forWorkspace(id: WorkspaceId): WorkspaceHandle | undefined
  resolveForPath(path: string): Promise<WorkspaceHandle | undefined>
}

interface WorkspaceHandle {
  readonly id: WorkspaceId
  readonly root: string                                   // 规范化绝对根（workspace.path）
  resolve(rel: string): Promise<FsTarget>                 // root 内绝对路径；逃逸即抛错
  assertInside(target: FsTarget): void                    // 非包含即抛错
  notePath(rel: string): string                           // <root>/notes/<rel>
  attachmentPath(id: AttachmentId, rel?: string): string  // <root>/attachments/<id>/[rel]
  archivePath(rel?: string): string                       // <root>/archive/[rel]
  newOperationContext(actor: Actor, opts?): OperationContext   // §4 工厂
}
```

**路径穿越防护**委托给 harness 原语，不重造：

1. `resolve(rel)` 拼接 `root`+`rel` 后 `await ctx.fs.resolve(absPath)`——规范化（`..`、symlink）为稳定 `FsTarget`。
2. `assertInside` 调用 `ctx.fs.contains(rootTarget, target)`——规范包含，`../` 逃逸、绝对路径注入、symlink 逃逸都被 seam 拒绝。
3. `rootTarget` 每个 handle 解析一次并缓存。

`newOperationContext` 是 OperationContext 工厂（§4），盖本 handle 的 `workspaceId`。

---

## 11. Outbox / Sync 扩展缝（决定 #11）

预留，不实现。Phase 1 无 WeKnora、无 outbox worker。

```ts
/** 未来持久化 outbox 条目（sync_records），为 WeKnora 同步 phase 预留。 */
export interface OutboxRecord {
  operationId: OperationId
  workspaceId: WorkspaceId
  target: 'note' | 'attachment' | 'fact'
  aggregateId: string
  aggregateRevision: number
  status: 'pending' | 'running' | 'success' | 'retry' | 'failed'
  attempts: number
  nextRetryAt?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

/** 扩展点：对已提交事件做出反应的消费者（未来 sync worker）。 */
export interface OutboxSink {
  /** 提交后、在 pkw/event.committed 信号之后调用。尽力而为，不得抛错。 */
  onCommitted(signal: PkwEventCommitted): void
}
```

缝只有一个钩子：`pkwEvents` 在提交后（尽力而为）通知已注册的 `OutboxSink`。未来 sync phase 会把 `OutboxSink` 变成持久化 `outbox`/`sync_records` 写入者 + 重试循环。Phase 1 不读写 `OutboxRecord`。

---

## 12. 服务拓扑与禁止跨插件 import（决定 #12 / #5）

所有领域能力都是 Cordis 服务，经 `ctx.<key>` 获取；Phase 1 任何包不得 import 另一个 PKW 包的实现类。

| 包 | 提供 | `inject`（硬依赖） | 说明 |
|---|---|---|---|
| `@deepseek-ai/dsh-pkw-domain` | 类型 + `pkwDomainSpec` + 接口声明（无运行时） | — | 纯定义包 |
| `@deepseek-ai/dsh-pkw-events` | `ctx.pkwEvents`（`PkwEventStore`） | `storageDomain` | 唯一写 `commits` 表 |
| `@deepseek-ai/dsh-pkw-workspace` | `ctx.pkwWorkspace`（`PkwWorkspace`） | `workspaceRegistry`, `fs`, **`pkwEvents`** | 变异依赖 `pkwEvents` 为硬注入 |

决定 #5 落实：`dsh-pkw-workspace` 对 `ctx.pkwEvents` 是**硬 `inject`**，不是 `ctx.get('pkwEvents')` 可选探测。变异型 PKW Host 服务必须保持「持久化历史」不变量，绝不静默绕过持久化事件。只读功能仍可独立测试，但生产变异必须经事件服务。

接口由 `dsh-pkw-domain` 内的 `interface Context` / `interface Events` 声明合并声明，仅由各自 provider 包实现——标准的 Service Definition / Provider 切分（`docs/architecture.md` § "Capability seams"）。

---

## 13. 包依赖图与 host bundle 归属（决定 #10）

```
@deepseek-ai/dsh-pkw-domain      （定义：ID 品牌、OperationContext、OperationCommit、
                                  DomainEvent、ContextSnapshot/SourceRef、OutboxSink、
                                  pkwDomainSpec、Context/Events 声明合并——无运行时）
  ├── peer: @deepseek-ai/cordis
  ├── peer: @deepseek-ai/dsh-brand
  ├── peer: @deepseek-ai/dsh-workspace        （复用 WorkspaceId）
  ├── peer: @deepseek-ai/dsh-storage-domain   （defineDomain/domainTable）
  └── dep:  zod

@deepseek-ai/dsh-pkw-events      （行；提供 ctx.pkwEvents）
  ├── inject: storageDomain
  ├── dep:  @deepseek-ai/dsh-pkw-domain
  └── peer: @deepseek-ai/dsh-storage-domain, @deepseek-ai/dsh-storage, cordis

@deepseek-ai/dsh-pkw-workspace   （行；提供 ctx.pkwWorkspace）
  ├── inject: workspaceRegistry, fs, pkwEvents
  ├── dep:  @deepseek-ai/dsh-pkw-domain
  └── peer: @deepseek-ai/dsh-workspace, @deepseek-ai/dsh-fs, @deepseek-ai/dsh-pkw-events, cordis

@deepseek-ai/dsh-pkw-base        （HOST bundle；仅 cordis.patch.yml，无运行时 API）
  └── 行：storage, storage-domain, storage-sqlite, workspace,
          dsh-pkw-events, dsh-pkw-workspace
      （dsh-pkw-domain 是两个 provider 的依赖/peer，不是行）
```

**包顺序（锁定）**：`domain → events → workspace → base`。`dsh-pkw-domain` 保持 runtime-free；`dsh-pkw-events` 提供 `ctx.pkwEvents`；`dsh-pkw-workspace` 提供 `ctx.pkwWorkspace` 且变异依赖 `ctx.pkwEvents`；`dsh-pkw-base` 组合 harness 的 storage/fs/workspace seam + PKW 服务。

Host bundle `@deepseek-ai/dsh-pkw-base`（决定 #6 落定 bootstrap）。它以 **`@deepseek-ai/dsh-base`** 为前置层（提供 `session`/`session-persistence`/`fs`/`sandbox`/`attachments`——`workspace` 行经 `ctx.workspaceRegistry` 传递依赖 `sessionPersistence`，故该前置层是硬要求）：

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-sqlite
  name: '@deepseek-ai/dsh-storage-sqlite'
  config:
    path: !!js dshHomePath('pkw', 'pkw.sqlite')   # 单个 harness 托管的 SQLite DB
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: sqlite                                # 默认全 domain 走 sqlite；routes 可逐 domain 覆盖
- id: workspace
  name: '@deepseek-ai/dsh-workspace'
- id: pkw-events
  name: '@deepseek-ai/dsh-pkw-events'
- id: pkw-workspace
  name: '@deepseek-ai/dsh-pkw-workspace'
```

要点（决定 #6）：

- **单库 + `workspaceId` 分区**，不做「每个 workspace 一个 `.system/workspace.sqlite`」。DB 路径 `dshHomePath('pkw', 'pkw.sqlite')` = `$DSH_HOME/pkw/pkw.sqlite`，由 harness 托管，规避 storage↔workspace 引导环、遵循 harness host 服务生命周期、支持未来多 workspace/多机部署、保留 backend 可替换性、且 PKW 业务代码不耦合 SQLite 路径。
- 结构化状态记录内已含 `workspaceId`（`OperationCommit.workspaceId`），据此分区/查询。
- `routes`（`storage-domain`）是 backend 可替换性的旋钮：某部署可把 `workspace` 留在 `json` 而只把 `pkw` 路由到 `sqlite`。
- 全新系统，无迁移负担（与仓库 pre-release「旧介质拒绝、无兼容承诺」一致）。

**不进入 agent preset、不进入 client（Phase 1）**：以上全部。agent preset 的 `notes.*`/`tasks.*`/`facts.*`/`knowledge.search`/`context.compile` 工具行只在 Phase 6/7 加入；client 的 Notes/Tasks/Knowledge/Activity UI 只在 Phase 7 加入。

---

## 14. 验收测试矩阵

每条验收标准映射到单测或真实组合测试（`docs/testing.md`）：

| # | 验收标准 | 设计机制 | 层级 |
|---|---|---|---|
| 1 | Workspace register/open | `ctx.workspaceRegistry.create` + `pkwWorkspace.forWorkspace` + `resolveForPath` | 单测（`storage-sqlite :memory:`）+ Loader 组合 smoke |
| 2 | 路径穿越防护 | `fs.resolve` 规范化 + `fs.contains`；`../`、绝对路径、symlink 逃逸均拒绝 | 单测 |
| 3 | 稳定 id 与 path 分离 | `NoteId`/`AttachmentId`/`EventId` 品牌；`path` 是独立可变字段；移动 ≠ 新 id | 单测 |
| 4 | `ctx.fs` 文件操作 | `readText`/`writeText`/`editText`/`listDir` 经 `ctx.fs`，不走 `node:fs` | 单测（fs-local） |
| 5 | `ctx.storage` 持久化 | `pkw` domain 打开，`commits` 表经 `storage-sqlite` 持久化 | 单测 |
| 6 | 持久化事件提交/查询 | `commit` → `get`/`list`（展平时间线） | 单测 |
| 7 | OperationContext 传播 | `newOperationContext` 盖 workspaceId；`commit` 使 actor/operationId/correlationId/causationId 进入 record **与** signal | 单测 |
| 8 | 事务回滚 | 校验失败 / 非法 schema ⇒ 不落盘、无信号；`commits` 表不变 | 单测 |
| 9 | 提交后 Cordis 信号 | 信号仅在 `commits.put` 成功后发出；携带 operationId+correlationId+event 元数据 | 单测 |
| 10 | 重启后事件仍在 | 重开 `pkw` domain ⇒ commits 与 revision cursor 仍在 | 单测 |
| 11 | 重复事件 / 幂等 | 同一 `operationId` 提交两次 ⇒ 一次 commit，第二次为 no-op（多事件组整体幂等） | 单测 |

外加仓库两条固定要求：每个 Phase 1 注册器有 HMR/teardown 安全测试（dispose fiber，断言清理），以及一个**真实组合**测试经 Loader 启动 `dsh-pkw-base` 行（`docs/testing.md` § "Test the real entry path"）。

---

## 15. Phase 1 明确不做

Tasks、Facts/Propositions、Relations、Notes 业务逻辑、Notes 索引、frontmatter 解析器、文件监听、WeKnora 客户端、MCP 接线、sync/outbox worker、Context Compiler、Agent 工具、persona/prompt 段、Web UI、审批、任何 `node:fs`/`better-sqlite3` 使用、任何跨插件实现 import。

---

## 16. 实现期再定（缩减后）

1. `EventId` 生成用 `randomUUID()`（v4，与 `WorkspaceId` 一致）还是时间可排序的 UUIDv7。Phase 1 用 `randomUUID()`；排序以 `aggregateRevision` + `createdAt` 为主。
2. `dsh-pkw-domain` 是纯类型包还是也 re-export `pkwDomainSpec`（运行时）。倾向：re-export spec，让 `dsh-pkw-events` 只有一个 import 面。
