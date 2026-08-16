# Phase 2 设计 — Markdown Notes + Attachments

> 项目：Personal Knowledge Workspace（PKW）
> 门禁：Phase 0 适配结论 + Phase 1 已批准事实是唯一事实源，不得推翻。
> 范围：**仅设计** Notes + Attachments（Host 面）。不写业务代码、不做 Task/Fact/WeKnora Sync/Agent Tool/Client UI。

---

## 1. 范围与不变事实

- 三平面：`Agent → Host`，`Client → Host`，`Host -X→ Agent`，`Host -X→ Client`。Phase 2 只做 **Host**。
- 复用 `ctx.workspaceRegistry`、`ctx.fs`、`ctx.storage`/`ctx.storageDomain`、`ctx.pkwEvents`、`ctx.pkwWorkspace`。
- 禁止 `node:fs`、`better-sqlite3` 出现在 PKW 业务源码。
- 事实源边界（非全局事件溯源）：
  - Markdown Note 正文 → `.md` 文件是事实源（**不**把正文塞进 storage 再生成 Markdown）。
  - Attachment binary → workspace 文件是事实源。
  - NoteIndex / Attachment catalog → `ctx.storage` projection。
  - 历史操作 → Durable Event Log。
  - WeKnora → 仅检索投影（Phase 2 **不**连接/调用/部署/修改 WeKnora，只留稳定边界）。
- Durable Event ≠ Cordis Event（前者可查询历史，后者 commit 后实时 signal）。

---

## 2. Harness 能力核验结论（真实源码路径）

| 能力 | 结论 | 证据 |
|---|---|---|
| 文本读 | ✅ `readText`/`streamText`/`readBytes` | `packages/fs/fs/src/index.ts:176/187/199` |
| 原子写 + 自建父目录 | ✅ `writeText`/`editText` 走 `writeFileAtomic`（`mkdir recursive` + staging + `rename`） | `packages/fs/fs-local/src/fsio.ts:543/561/591` |
| 写守卫（createIfAbsent / replaceIfVersion） | ✅ `FsWriteIntent` | `packages/fs/fs/src/types.ts:123` |
| 目录列举 / stat / lstat（symlink 探测） | ✅ `listDir`/`stat`/`lstat`；`FsPathInfo.type='symlink'` | `types.ts:91` |
| 路径包含 | ✅ `contains(parent, child)` | `fs/src/index.ts:144` |
| **文件删除 / 重命名 / 移动** | ❌ **GAP**：seam 无 `delete`/`rename`/`move`（`fs-local` 内部 `fsio.ts` 已有 `rm`/`rename`/`mkdir`，但未暴露） | `fs/src/index.ts` 抽象方法仅有 resolve/stat/lstat/read*/listDir/writeText/editText |
| **二进制写** | ❌ **GAP**：有 `readBytes`，无 `writeBytes`（seam 是 UTF-8 文本向，拒绝 binary） | `fs/src/index.ts` |
| 文件 watcher | ⚠️ 无 `ctx.fs.watch`，但 `chokidar` 已是 harness **直接依赖**（settings-file / credentials-local / skill-filesystem / vendor HMR） | `packages/skill/skill-filesystem/src/index.ts:488` `chokidar.watch(anchor)` |
| mtime | ⚠️ `FsInfo`/`FsVersion` 不暴露 mtime（`FsVersion` 是不透明 freshness token） | `types.ts:76` |
| Markdown 解析 | ⚠️ micromark/mdast 已在树里（客户端传递依赖）；`unified`/`remark-parse`/`remark-gfm`/`gray-matter` 非顶层 | `node_modules/.pnpm/micromark-*`、`mdast-util-*` |

### ctx.attachments 核验结论（复用性判定）

真实源码：`packages/attachment/attachment/src/index.ts`+`types.ts`、`attachment-local/src/index.ts`+`store.ts`。

`ctx.attachments`（harness 自带 attachment store）真实能力：

| 维度 | 事实 |
|---|---|
| Service | `ctx.attachments: AttachmentStore`，仅有 `saveImage`/`validateImage`/`readImage` |
| binary 类型 | **仅 4 种光栅图** `image/png|jpeg|webp|gif`（`ImageMediaType`），保存时**完整解码光栅**（width/height/pixels） |
| 身份模型 | **content-addressed**：`attachmentId = sha256:<hex>`（`store.ts:190`） |
| 可变性 | **immutable**：无 delete/rename/move/update |
| 存储位置 | `$DSH_HOME/attachments/v1/objects/<2hex>/<sha256>`（owner-private，fsync + hard-link 去重） |
| 绑定 | 引用写入 session log（"before its owning session event is appended"），**不绑定 workspace** |

**结论：`ctx.attachments` 不适合作为 PKW Attachment binary 的长期事实源。** 具体原因：

1. **仅支持光栅图片**——PKW 附件是任意二进制（PDF/DOCX/XLSX/音频/归档/图片…），非图片会被 raster decode 拒绝。
2. **identity 与 binary fingerprint 强制合一**（`attachmentId = sha256`）——违反「`AttachmentId ≠ sha256`」；内容相同但业务生命周期不同的附件被强制合并为同一对象。
3. **不可变 + 无 delete/rename**——PKW 需要附件生命周期（remove）。
4. **不绑定 workspace、不控制物理路径**——PKW 事实源要求 binary 在 workspace 树内可移植，路径为 `attachments/<AttachmentId>/...`。

因此 PKW **不复用** `ctx.attachments`，也**不在 PKW 内重建第二套通用 binary store**——而是把通用 binary 写能力补回 `ctx.fs`（GAP-2）。`ctx.attachments` 继续只服务 harness 自身 LLM-vision 图片场景。

### HARNESS_CAPABILITY_GAPS（结论）

**GAP-1 — `ctx.fs` 缺结构变更 `rename`/`remove`（通用文件系统能力）。**
- 现有能力：seam 只能 read + atomic-text-write；`fs-local` 内部 `fsio.ts` 已有 `rm`/`rename`/`mkdir`（**已实现，未暴露到 seam**）。
- 缺失能力：seam 无 `rename`/`remove`（`move` 由 `rename` 表达）。
- PKW 为什么需要：`notes.move()`、`notes.delete()`（软删移 `archive/`）、`attachments.remove()`。
- 归属：**通用 Harness 能力**，非 PKW 特有。
- 建议补法：**方案 A** 扩展 `FileSystem` abstraction，增 `rename(source, dest)` + `remove(target)`；`fs-local` 薄封装已有原语；`fs-sandbox` 按 sandbox policy 拦截；补 harness tests。
- 是否阻塞：**部分**——阻塞 PKW 主动 move/delete mutation；不阻塞 reconcile 检测。

**GAP-2 — `ctx.fs` 缺二进制写 `writeBytes`（经 `ctx.attachments` 核验后确认仍为 gap）。**
- 现有能力：`readBytes` 可读 binary；`writeText` 拒绝非 UTF-8；`ctx.attachments` 仅图片且 identity=sha256，不适合通用附件。
- 缺失能力：seam 无通用 binary 写。
- PKW 为什么需要：`attachments.import()` 落盘任意二进制到 `attachments/<AttachmentId>/...`。
- 归属：**通用 Harness 能力**。
- 建议补法：**方案 A** 扩展 `FileSystem` 增 `writeBytes(target, bytes, intent?, signal?, policy?)`；`fs-local` 复用 `writeFileAtomic` 的 binary 变体（temp+sync+rename）；`fs-sandbox` 拦截。
- 是否阻塞：**是**（附件导入 mutation 路径）。

**GAP-3 — 缺 domain-facing watcher abstraction（不是 chokidar 依赖本身）。**
- 现有能力：`chokidar` 已是 harness 直接依赖（settings-file/credentials-local/skill-filesystem/vendor HMR 均有 watcher precedent）。
- 缺失能力：无统一 watcher service seam（无 `ctx.fs.watch`）。
- PKW 为什么需要：Notes 低延迟发现外部变化，但 **Notes domain 不得直接 import chokidar**。
- 归属：**通用 Harness 能力**（本阶段用 PKW host adapter 落地，后续可提升为通用 seam）。
- 建议补法：新增 `FileWatch` abstraction（domain 接口）+ `dsh-pkw-filewatch`（chokidar provider，唯一 import chokidar 的包）。Notes 依赖 `ctx.pkwFileWatch`，不感知 chokidar。
- 是否阻塞：否。

**GAP-4 — 无 mtime（非 gap）。** `FsInfo`/`FsVersion` 不暴露 mtime；NoteIndex 新鲜度用 `contentHash`+`observedRevision`（PKW 派生），`updatedAt` 用 PKW 派生时间。

**Markdown parser（非 gap，记录）。** 需新增 host-only **直接依赖** `unified`/`remark-parse`/`remark-gfm`/`gray-matter`（不依赖 harness 传递依赖的偶然存在）。

> 设计约束：GAP-1/GAP-2 的 `ctx.fs` 扩展是 **Phase 2 mutation 面的前置**（host 面 harness 改动，方案 A，见 §21）。reconcile 检测面完全不受阻塞。

---

## 3. Note Identity（NoteId ≠ path）

- `NoteId`：稳定、生成后不变、**绝不由路径派生**。来源是 Markdown frontmatter 的 `id` 字段；文件缺 `id` 时由 PKW 生成并写回（见 §9）。
- 格式：`note_` + 加密随机短串（如 `note_01KABC`；具体字母表是实现细节）。已有 `id` 一律尊重，不重排、不重写。
- 路径：`relativePath`（相对 workspace 的 POSIX 路径，位于 `notes/` 下，如 `工作/Agent/WeKnora.md`）是独立、可变字段。
- 移动/重命名 = 只改 `relativePath`，`NoteId` 不变 → 识别为 `note.moved`，而非 `note.deleted` + `note.created`。
- 目录结构真实对应文件系统；不存在「仅数据库里的虚拟目录」。

---

## 4. Frontmatter Contract

最小、稳定、可携带。示例：

```markdown
---
id: note_01KABC
title: DeepSeek Harness
tags: [agent, harness]
---

# DeepSeek Harness
正文……
```

| 类别 | 字段 | 说明 |
|---|---|---|
| 系统字段（必填） | `id` | `NoteId`，唯一身份 |
| 用户字段（可选，系统只读不覆盖） | `title`、`tags`、`created_at` | `created_at` ISO-8601，用户可维护；系统不强制写 |
| **禁止进入 frontmatter**（系统 projection） | `content_hash`、`observed_revision`、`indexed_at`、`sync_status`、`weknora_id`、`last_synced_at`、`remote_revision`、`retry_count` | 避免后台索引行为不断改写用户 Markdown |

- 解析用 `gray-matter`（只读）；**注入 `id` 用 `editText` 定点补丁**（见 §12），绝不整篇重新 stringify。
- frontmatter 之外的正文一律原样保留。
- **title fallback**：`frontmatter.title → 第一个 Markdown H1 → filename`。`title` 与 `tags` 均允许缺省（普通 `.md` 直接进 PKW）。

---

## 5. Observed Revision（contentHash + observedRevision）

- 不依赖用户/外部编辑器维护 revision。
- `contentHash = sha256(规范内容)`（LF 归一化后；与 `ctx.fs` 的 diff basis 一致）。
- `observedRevision`：首次观察 = 1；`contentHash` 改变 = +1；hash 不变 = 不变。
- 属于 **NoteIndex projection**，不在 Markdown 正文。

---

## 6. NoteIndex Projection + Domain 表

`NoteIndexRecord`（projection，不存正文副本；正文读取必须经 `ctx.fs` 读真实 `.md`）：

```ts
interface NoteIndexRecord {
  noteId: NoteId
  workspaceId: WorkspaceId
  relativePath: string
  title: string
  tags: string[]
  contentHash: string
  observedRevision: number
  fileSize: number
  createdAt: string          // 首次发现
  updatedAt: string          // 最近一次观察到的变化（PKW 派生，非 fs mtime）
  deletedAt?: string         // 软删除标记
}
```

Domain 拆分（各服务自有 domain，避免「两服务争开同一 domain」的 already-open 冲突）：

- `pkw`（v1，不变）：`commits`（Durable Event Log，events 服务所有）。
- `pkw_notes`（v1，新）：`note_index`（`NoteId → NoteIndexRecord`）、`note_paths`（`relativePath → NoteId` 反向索引，供 reconcile 检测 move / 重复路径）。
- `pkw_attachments`（v1，新）：`attachments`（`AttachmentId → AttachmentRecord`）。

三者经 `storage-domain` `routes` 全部路由到 `sqlite`（backend 可替换）。

---

## 7. Note Domain Model

区分「身份/索引元数据」与「文档」：

```ts
/** Note 身份 + 索引 projection。 */
interface Note {
  id: NoteId
  workspaceId: WorkspaceId
  relativePath: string
  title: string
  tags: string[]
  contentHash: string
  observedRevision: number
  fileSize: number
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

/** 文档：WeKnora Sync / Agent Context 只依赖它。 */
interface NoteDocument {
  note: Note
  markdown: string              // 经 ctx.fs 读真实 .md
  attachments: AttachmentRef[]  // 由 Markdown 解析得到的 managed attachment 引用
}

interface AttachmentRef {
  attachmentId: AttachmentId
  relativePath: string          // attachments/<id>/<filename>
}
```

> 未来 `dsh-weknora-sync` 只依赖 `ctx.notes.getDocument(noteId)`，不自己理解文件夹规则/frontmatter/附件物理路径/Markdown 布局。

---

## 8. Notes Service（ctx.pkwNotes）

> **命名修正**：PKW 服务统一 `ctx.pkw*` 前缀，避免与 Harness 现有/未来 namespace 冲突。`ctx.notes` → **`ctx.pkwNotes`**；`ctx.attachments` → **`ctx.pkwAttachments`**（`ctx.attachments` 已被 Harness Vision Attachment Service 占用）。

```ts
interface PkwNotesService {
  // 查询
  list(filter?: NoteListFilter): Note[]
  get(noteId: NoteId): Note | undefined
  getDocument(noteId: NoteId): Promise<NoteDocument>
  resolveByPath(relativePath: string): Note | undefined

  // 显式 mutation
  create(input: CreateNoteInput): Promise<Note>                    // writeText + note.created
  update(noteId: NoteId, content: string): Promise<Note>           // guarded writeText/editText + note.updated
  move(noteId: NoteId, newRelativePath: string): Promise<Note>     // GAP-1（需 ctx.fs.rename）
  delete(noteId: NoteId): Promise<void>                            // GAP-1（软删移到 archive/，需 rename）

  // reconcile + conflict
  reconcile(): Promise<ReconcileReport>                            // 扫描 + 对比 + 提交事件
  getIdentityConflict(noteId: NoteId): NoteIdentityConflict | undefined
  listIdentityConflicts(): NoteIdentityConflict[]
}
```

- `list` 默认排除 `deletedAt` 非空的记录。
- `get(noteId)` 在 `note.identity_conflict` 状态下不静默选一个（见 §10）。
- 服务不暴露存储实现；正文读写全走 `ctx.fs`。

---

## 9. Missing NoteId Policy（发现外部文件）

发现合法 Markdown 且缺 `id`：

```text
生成 NoteId
→ editText 最小化注入 frontmatter id（不重写全文）
→ 重新读取真实文件（确认注入后的真实状态）
→ parse + contentHash
→ persist Durable OperationCommit（note.discovered）
→ 更新 NoteIndex projection
→ emit note-level signal
```

- 这属于「系统识别外部文件后的 mutation」，**必须记录历史**（不能悄悄写文件）。顺序原则：**Durable observation 先于 Projection 更新**（见 §12/§13）。
- 注入失败（版本冲突/写失败）→ 不建立索引，记录错误，留待下轮 reconcile 重试（幂等）。

---

## 10. Duplicate NoteId Policy（身份冲突）

两文件同 `id` → `note.identity_conflict.detected`，**默认不自动改任一文件身份**。

- **表示**：`note_paths`（或等价 observation table）表达 `NoteId → 0..N observed paths`。`N > 1` 时 `identityStatus = conflict`，且 `NoteIndexRecord.relativePath` 在冲突态为 **非权威/未定义**——`ctx.pkwNotes.get(noteId)` 不得通过 `relativePath` 随便选一个文件。
- 冲突如何查询：`getIdentityConflict(noteId)` / `listIdentityConflicts()`（`{ noteId, paths: string[] }`）。
- 解决（未来 UI / 本阶段仅 domain API）：`resolveConflict(noteId, keepPath, reassignedPath)` → 对 reassigned 文件 `editText` 改 `id` 为新 NoteId → 更新索引 → `note.identity_conflict.resolved`。扫描器**禁止**自行解决冲突。
- 禁止：静默覆盖、随机选一个、后扫描覆盖先扫描。

---

## 11. Note Move / Delete Policy

**Move**（`NoteId` 判定）：旧路径不存在 + 新路径存在 + 同 `NoteId` → `note.moved`。`rename`（同目录改名）与 `move`（跨目录）统一为 `relativePath` 变化 → 同一 `note.moved`，payload 记录 `fromPath`/`toPath`。

**Delete**（外部删除）：文件不存在 + 索引存在 → 软删 projection（`deletedAt` 标记），事件 `note.deleted`。**Note 事实源已不存在时，NoteIndex 不伪装文件仍存在**（list 默认排除已删）。文件重新出现 → reconcile 清除 `deletedAt`（恢复）。

- 软删 vs 硬删：Phase 2 只做 **projection 软删**（`deletedAt`）。真正文件删除是 GAP-1（`ctx.fs.delete`），其 mutation 面待扩展。
- move/delete 的**检测**（reconcile）完全可用现有 seam 实现；**PKW 主动 move/delete 的 mutation** 依赖 GAP-1。

---

## 12. Atomic Write + Markdown 解析边界

**Atomic write**：复用 `ctx.fs.writeText`/`editText`（已是 temp+rename 原子写 + `mkdir recursive`）。写守卫：
- 创建：`writeText(target, content, { kind: 'createIfAbsent' })`。
- 更新/注入 id：`editText`（literal 替换 + 版本守卫）或 `writeText(..., { kind: 'replaceIfVersion', version })`。

**解析用于识别结构，最小化文本修改**：
- Frontmatter：`gray-matter` 只读解析。
- Attachment link 识别：`unified`+`remark-parse`+`remark-gfm` 生成 mdast，遍历 `link`/`image` 节点。**基于 AST**（`code` 节点内容不会被当成 link），不做全局 Regex。
- 注入 `id` / 改写 link：用 AST `position`（节点起止偏移）做 **targeted `editText`**，不整篇 stringify。改写只覆盖 managed link（见 §15），不改 HTTP URL、用户普通相对路径、wiki link、代码块文本。

**内部 Note mutation 顺序（锁定，Event-first）**：

```text
1. 依据旧文件版本验证 optimistic guard（stat().version / FsWriteIntent）
2. ctx.fs atomic write / editText
3. 重新读取真实 Markdown
4. parse + contentHash（新 observed state）
5. persist Durable OperationCommit（显式 mutation 用 OperationContext.operationId）
6. 更新 NoteIndex projection
7. emit note-level signal（pkw/note.changed）
```

**跨资源事务不存在（明确接受）+ Crash-gap 恢复**：`.md` 写成功 → crash → Durable Event 尚未写，这是无法用 filesystem+storage 获得真事务的结果。**不把 Note 改成 event-sourced aggregate**。恢复方式：
- 若 `File 成功 → Event 成功 → 💥 → Projection 未更新`：可恢复（Projection 是派生物，Startup Reconcile 重建）。
- 若 `File 成功 → 💥 → Event 未写`：下次 Reconcile 发现 `真实 hash ≠ NoteIndex hash`，补一个 reconciliation OperationCommit（`actor=system`）。
- 第 5 步失败：文件已是真实状态，**不伪装回滚**，靠 Watcher/Startup Reconcile 恢复 durable observation。

区分两类事件：显式 mutation（`actor.type ∈ {agent,user}`）与 reconcile observation（`actor.type = system`）。

---

## 13. 外部编辑 + Watcher + Reconcile

**Watcher（低延迟，独立 accelerator）**：Watcher 只是加速器，Startup Reconcile 才是正确性机制。**`ctx.pkwNotes`/`ctx.pkwAttachments` Core 不硬依赖 watcher**（无 watcher 时 create/read/update/move/delete/reconcile/getDocument 仍完整可用）。

拆分三层，形成 `Watcher Provider → Watch Bridge → Domain Service reconcile`，而非 `Notes Domain → chokidar`：

- `dsh-pkw-filewatch`（`ctx.pkwFileWatch`）：chokidar provider，唯一 import chokidar 的包。
- `dsh-pkw-notes-watch`（薄协调层）：订阅 `ctx.pkwFileWatch` → 检测 notes/attachments 变化 → debounce → 调 `ctx.pkwNotes.reconcile()` / `ctx.pkwAttachments.reconcile()`。
- `dsh-pkw-notes` / `dsh-pkw-attachments`：domain core，**不含** watcher 依赖，暴露 `reconcile()`。

本地 bundle 默认装 watcher accelerator；未来 remote filesystem / cloud object provider 可替换 watcher provider，不改 Notes domain。

**Reconcile（最终一致，幂等，NoteId-first）**：

```text
扫描 notes/**/*.md（listDir 递归 + stat）
→ 每文件：relativePath + contentHash + frontmatter(noteId)
→ 以 NoteId 为主键构建 observedById[noteId]（携带 path/hash）
→ 与 note_index / note_paths 按 NoteId 对比（非 path 扫描顺序）：
   · id 未知 + 有 id              → note.created（外部显式）或 note.discovered
   · id 未知 + 无 id              → Missing NoteId policy → note.discovered
   · 同 id + 路径变化             → note.moved（批量目录移动 = N 条 moved，不是 N 删+N 建）
   · 同 id + 同路径 + hash 变化   → note.updated（observedRevision+1）
   · 同 id + 同路径 + hash 不变   → 无事件（幂等）
   · 索引有 id + 文件缺失且未移动 → note.deleted（软删）
   · 两文件同 id                   → note.identity_conflict.detected
→ 为每个 decision 计算稳定 ReconcileFingerprint → 稳定 operationId
→ persist Durable OperationCommit（先于 projection）
→ 更新 NoteIndex projection（note_index / note_paths）
→ emit note-level signal（pkw/note.changed）
```

**ObservedStateFingerprint（状态身份，≠ operationId/correlationId/eventId）**：描述 Note 当前「可观测真实状态」：

```text
ObservedNoteStateFingerprint = hash(workspaceId, noteId, relativePath, contentHash, existence/deleted, identityConflict)
```

（`title`/`tags` 由 Markdown content 派生，`contentHash` 已覆盖。）

**每条 Note 状态变更 Event 都记录 `afterStateFingerprint`（必要时 `beforeStateFingerprint`）**，使 Durable History 自身能回答「此文件状态以前是否已被持久观察过」。

**Reconcile 持久幂等身份（关键，基于 Durable Transition）**：reconcile 先查 Durable Observation，再决定是否产生事件：

```text
读取 filesystem → currentFilesystemFingerprint
→ 读 NoteIndex projection（可能落后）
→ 读该 Note 最新 durable afterStateFingerprint
   · latest durable == filesystem fingerprint → 仅 repair Projection（不产生新 event）
   · latest durable != filesystem fingerprint → 创建新 reconcile commit
```

```text
ReconcileFingerprint = hash(workspaceId, noteId, latestDurableFingerprint, currentFilesystemFingerprint, changeKind)
operationId = OperationId(`reconcile:${ReconcileFingerprint}`)
```

- **Durable History 决定某 observed state 是否已记账，而不是 Projection 决定**（Projection 只是可能落后的派生物）。
- 同一 transition 重试 → 同一 `operationId` → 幂等 no-op；新状态 → 新 fingerprint → 新 operation。
- 解决两个漏洞：① reconcile commit 成功 + projection 失败 → 重试不重复事件；② 显式 update 的 Event 成功 + projection 失败 → reconcile 不会把「已被显式事件记账的状态」再记成 reconcile 事件。
- **Projection repair 不是新的 domain event**（History 已含 B、Projection 仍是 A、filesystem 是 B → 只修 projection，不产生 `note.updated`；可 debug log/metrics，未来如需审计用独立 maintenance event）。

**mutation 顺序（锁定，Event-first）**：`File 修改 → 重读真实状态 → parse+hash → persist Durable OperationCommit → 更新 NoteIndex projection → emit note-level signal`。**Durable observation 先于 Projection 更新**；Projection 是派生物，crash 后由 reconcile 重建。

- **幂等**：重复启动且文件无变化 → 不产生重复 revision、不产生重复事件。
- 覆盖：运行期外部改、关闭期改、外部建/删/移、批量移动目录、watcher 漏事件、异常退出、平台 rename 差异。

---

## 14. Attachments（identity / storage / hash / link）

**Identity**：`AttachmentId` 独立稳定，`≠ NoteId`。物理结构锁定：

```text
attachments/<attachmentId>/<safe-filename>
```

**Fact boundary**：binary = workspace 文件（事实源）；metadata = `ctx.storage` catalog：

```ts
interface AttachmentRecord {
  id: AttachmentId
  workspaceId: WorkspaceId
  filename: string        // safe-filename（原始名做安全化）
  mimeType: string
  sizeBytes: number
  sha256: string
  relativePath: string    // attachments/<id>/<filename>
  observedRevision: number  // 首次观察=1；binary hash 改变=+1；不变不 bump
  indexedAt: string
  createdAt: string
  deletedAt?: string
}
```

**Attachment observed state / reconcile policy**：Attachment binary 也是 Workspace File 事实源，catalog 同样是 projection。外部程序覆盖 `attachments/<id>/<file>`（`AttachmentId` 不变、`sha256`/`sizeBytes` 变）→ reconcile 检测为 `attachment.updated`（`observedRevision+1`）；binary 真实不存在 → `attachment.deleted`（软删）。规则与 Note 一致（hash 驱动，不依赖外部维护 revision）。

**Attachment rename policy（MVP 明确行为）**：PKW 管理的 attachment filename 不鼓励外部 rename。若检测到 filename 变化：默认按 `AttachmentId` 目录重新发现唯一文件（目录内唯一文件 = 该附件，catalog 更新 `filename`）；若目录内文件非唯一或缺失 → 进入 repair/conflict 状态，**不做大规模静默全文重写所有 Note 的 link**。行为必须明确，不做未定义。

**Binary backend 决策（最终）**：PKW 附件 binary 由 **`ctx.fs`（扩展 `writeBytes` 后）+ workspace 文件 `attachments/<AttachmentId>/<safe-filename>`** 承担，**不复用** harness `ctx.attachments`（图片专用、immutable、identity=sha256、不绑定 workspace——见 §2 核验结论）。逻辑模型优先于物理路径模型；`attachments/<AttachmentId>/...` 是 PKW 自己的文件事实源，不是 harness attachment store。

**Hash**：`sha256`（`node:crypto`）。**binary identity ≠ attachment identity**：`sha256` 是属性不是主键。Phase 2 **不做去重**（每次 import 新 `AttachmentId`，即使 sha256 相同），只记录 `sha256` 供未来 dedupe-detection / WeKnora 优化 / integrity 校验；「重复 binary ≠ 重复 AttachmentId」。

**Link**：标准 Markdown，不发明 `pkw://`：

```markdown
![架构图](../../attachments/att_01ABC/architecture.png)
[需求文档](../../attachments/att_01DEF/spec.pdf)
```

**Managed vs 非 managed**：只有能解析为 `workspace/attachments/<AttachmentId>/...` 的链接才允许 PKW 自动处理。HTTP URL、用户普通相对路径（如 `../assets/foo.png`）、wiki link 一律不碰。

---

## 15. Attachment Service（ctx.pkwAttachments）

```ts
interface PkwAttachmentsService {
  get(attachmentId: AttachmentId): AttachmentRecord | undefined
  resolve(relativePath: string): AttachmentRecord | undefined   // managed path → record
  importFile(input: ImportAttachmentInput): Promise<AttachmentRecord>  // GAP-2（writeBytes）
  open(attachmentId: AttachmentId): Promise<Uint8Array>          // readBytes
  remove(attachmentId: AttachmentId): Promise<void>              // GAP-1（remove）
  reconcile(): Promise<ReconcileReport>                          // 扫描 attachments/ + 对比 + 提交事件
}
```

- Notes Service 不自己成为附件存储实现。Notes 的 link 解析是**路径级**（解析 `attachments/<id>/...`），不依赖 attachments 服务；需要完整附件元数据时才 `ctx.get('pkwAttachments')`（可选依赖）。
- **PKW `AttachmentId` 与 Harness Vision `attachmentId` 没有身份等价关系**：前者来自 `dsh-pkw-domain`，后者是 `sha256:<hex>` content address（仅 Harness 图片场景）。

**Note Move 与 attachment link（§15 决策）**：`notes.move()` 识别 managed links → 按新旧相对位置重算相对路径 → **只**用 AST 定点改写这些 link 的 URL；不改 HTTP URL、用户普通相对路径、wiki link、代码块文本。

---

## 16. Durable Event Types

`aggregateType` 统一 `note`（或 `attachment`）；`aggregateId` = 相应 id。`actor.type` 区分显式（agent/user）与 reconcile（system）。

| 事件 | 何时产生 | payload 要点 | 来源 |
|---|---|---|---|
| `note.created` | 显式 create | `{ noteId, relativePath, title }` | 显式 mutation |
| `note.discovered` | reconcile 发现外部文件（含缺 id 补发） | `{ noteId, relativePath, title, hadId }` | reconcile |
| `note.updated` | 内容 hash 变化 | `{ noteId, relativePath, contentHash, observedRevision, prevHash }` | 显式或 reconcile |
| `note.moved` | 同 id 路径变化 | `{ noteId, fromPath, toPath }` | 显式或 reconcile |
| `note.deleted` | 文件缺失（软删） | `{ noteId, relativePath }` | 显式或 reconcile |
| `note.identity_conflict.detected` | 重复 id | `{ noteId, paths }` | reconcile |
| `note.identity_conflict.resolved` | 冲突重分配 | `{ noteId, keptPath, reassignedPath }` | 显式（未来） |
| `attachment.imported` | 显式导入 binary | `{ attachmentId, filename, sha256, sizeBytes, observedRevision }` | 显式 |
| `attachment.updated` | 外部 binary replacement（sha256 变化） | `{ attachmentId, sha256, sizeBytes, observedRevision }` | reconcile |
| `attachment.deleted` | 真实 binary 不存在（软删） | `{ attachmentId }` | reconcile |
| `attachment.removed` | 显式移除 | `{ attachmentId }` | 显式 |

> 判断：合并 `note.created` 与 `note.discovered` 会丢失「显式 vs 系统补发现」语义（§18 要求区分），故保留；**不**设泛化的 `note.reconciled`（过于笼统，reconcile 产生具体事件 + `actor=system` 即可）。

### Note-level live signal（高于 pkw/event.committed）

- `pkw/event.committed`：底层 Durable Commit signal（Phase 1 已有）。
- `pkw/note.changed`：高层稳定信号，**仅在** `File 稳定 + OperationCommit persisted + NoteIndex projection updated` 之后 emit；payload `{ noteId, changeKind, operationId }`。
- 未来 `dsh-weknora-sync` 订阅 `pkw/note.changed`（收到后 `ctx.notes.getDocument(noteId)` 能读到稳定状态），而非抢在 `pkw/event.committed` 后 projection 未稳定时读取。

### Reconcile 的 operationId 与显式 mutation 区分

- 显式 mutation：`OperationContext.operationId`（随机 UUID，来自 `newOperationContext`）。
- Reconcile observation：`operationId = OperationId('reconcile:' + ReconcileFingerprint)`（确定性，重试幂等）。
- 两者都进入统一 Durable Event Log（`commits` 表），仅 identity 生成方式不同。

---

## 17. Package 依赖图（最终）

```
dsh-pkw-domain        （类型：Note/Attachment/事件 payload/FileWatch 接口/域 spec；runtime-free）
    ↓
dsh-pkw-events        （ctx.pkwEvents；inject storageDomain）
dsh-pkw-workspace     （ctx.pkwWorkspace；inject workspaceRegistry, fs, pkwEvents）
dsh-pkw-filewatch     （ctx.pkwFileWatch；chokidar provider，唯一 import chokidar 的包）
    ↓
dsh-pkw-notes         （ctx.pkwNotes；inject fs, pkwWorkspace, pkwEvents；可选 ctx.get('pkwAttachments')）
dsh-pkw-attachments   （ctx.pkwAttachments；inject fs, pkwWorkspace, pkwEvents）
dsh-pkw-notes-watch   （薄协调层：pkwFileWatch → debounce → pkwNotes.reconcile / pkwAttachments.reconcile）
    ↓
dsh-pkw-base          （bundle：新增 notes/attachments/filewatch/notes-watch 行 + storage routes）
```

- **无 `dsh-pkw-notes ↔ dsh-pkw-attachments` 循环依赖**：二者只依赖 domain/workspace/events，通过 `attachments/<id>/...` 路径约定 + 可选 `ctx.get` 关联。
- **Notes/Attachments Core 不依赖 watcher**：`FileWatch` 接口在 domain，chokidar 只在 `dsh-pkw-filewatch`；`dsh-pkw-notes-watch` 是唯一 watch→reconcile 桥接。无 watcher 时 domain 仍完整可用。
- `dsh-pkw-domain` 新增 Phase 2 类型 + `pkw_notes`/`pkw_attachments` 域 spec + `FileWatch` 接口；`dsh-pkw-events`/`dsh-pkw-workspace` 不变。
- 全部属 host bundle；agent preset 与 client 仍不包含。
- host-only **直接依赖**：`chokidar`（仅 filewatch）、`unified`+`remark-parse`+`remark-gfm`+`gray-matter`（notes，direct dependency）、`sha256` 用 `node:crypto`。

---

## 18. Acceptance Test Matrix（Phase 2）

### Notes
1. 创建 Note 后真实 `.md` 文件存在。
2. 重启后 Note 可从 Markdown 恢复（索引重建/持久化）。
3. NoteId 与 path 分离（改 path 不改 id）。
4. Note move 后 NoteId 不变（外部 rename → reconcile 出 `note.moved`）。
5. rename 后 NoteId 不变。
6. 外部修改 Markdown 后 reconcile 能发现（`note.updated`）。
7. 关闭期间修改，重启能发现。
8. 外部创建 Markdown 能 discover（`note.discovered`）。
9. Missing NoteId 按 policy 处理（生成 id + 注入 + 事件）。
10. Duplicate NoteId 不静默覆盖（`note.identity_conflict.detected`）。
11. 外部删除文件能 reconcile（软删 `note.deleted`）。
12. 相同 hash 重复扫描不 bump revision（幂等）。
13. hash 改变后 observedRevision +1。
14. `../` path traversal 拒绝。
15. absolute path escape 拒绝。
16. symlink escape：`lstat` 探测 `symlink` 拒绝跟随（或明确记录 harness gap）。
17. 内部 mutation 产生 Durable Event（`note.created`）。
18. reconcile mutation 产生对应 Durable Event（`actor=system`）。
19. failed durable commit 不 emit committed signal。
20. crash-gap/restart reconcile 模拟测试。

### Attachments
21. Import 后真实 binary 存在（**依赖 GAP-2 扩展**）。
22. AttachmentId 与 NoteId 无关。
23. SHA-256 正确。
24. attachment path 不能逃逸 Workspace（`contains`）。
25. 重启后 attachment catalog 可恢复/可 reconcile。
26. managed image link（`![..](attachments/<id>/..)`）解析到 Attachment。
27. managed file link（`[..](attachments/<id>/..)`）解析到 Attachment。
28. HTTP URL 不误识别。
29. 普通用户 relative link 不误改。
30. code block 中示例链接不误识别（AST）。
31. Note move 后 managed link 仍有效（rewrite）。
32. 相同 binary 的去重 policy 有测试（Phase 2 明确「不去重」，测试锁定该行为）。

### Architecture Guards
33. Notes/Attachments 业务源码不 import `node:fs`。
34. 不直接依赖 `better-sqlite3`。
35. 不调用 WeKnora。
36. 不注册 Agent Tool。
37. 不注册 Client UI。
38. Host 不依赖 Agent/Client package。

### Crash / Reconciliation / Signal（新增）
39. Durable reconcile commit 成功、projection 更新前 crash：重启后 projection 可重建、事件不丢失。
40. 重启后同一 observed transition 不产生重复 Durable Event（ReconcileFingerprint 幂等）。
41. projection 恢复后 reconcile 再次运行保持幂等。
42. 新 hash 产生新的 reconciliation operation（新 fingerprint → 新 operationId）。
43. note-level signal（`pkw/note.changed`）只能在 projection 稳定后 emit（不在 `pkw/event.committed` 之前）。
44. ctx.attachments 生命周期适配测试：**不适用**（PKW 不复用 ctx.attachments，见 §2）；改为锁定 PKW 附件 catalog 重建/reconcile。
45. fs rename/remove substrate tests（若扩展 ctx.fs，测试该扩展的语义 + 版本守卫 + 原子性）。
46. sandbox/path escape 对 rename/remove/writeBytes 同样有效（扩展不绕过安全边界）。
47. 批量目录移动按 NoteId 识别为 N 条 `note.moved`（不是 N 删+N 建）。

---

## 19. Phase 2 明确不做

Task（checkbox 仅视为 Markdown 文本）、Fact/PLL、Relations、WeKnora 连接/上传/搜索/删除/reparse、Agent Tool、Preset、Client UI、附件去重、`Note ↔ Attachment` 显式 join 表（Phase 2 由 Markdown 解析派生，join 留给未来 Relations）。

---

## 20. 设计关键决策汇总（写代码前必须锁定）

1. **Frontmatter**：仅 `id`（系统必填）+ `title`/`tags`/`created_at`（用户可选）；projection 字段一律不进 frontmatter；title fallback = title → H1 → filename。
2. **外部编辑/Reconcile**：`FileWatch` abstraction（Notes 不感知 chokidar）+ 启动 reconcile（最终一致、NoteId-first、幂等、`actor=system` 区分补发现）。
3. **mutation 顺序（Event-first）**：`File → Durable OperationCommit → Projection → note-level signal`；**Durable observation 先于 Projection**。
4. **Reconcile 幂等身份**：`operationId = 'reconcile:' + ReconcileFingerprint`（确定性），重试不重复制造事件。
5. **Missing/Duplicate NoteId**：缺失→生成+定点注入+`note.discovered`（Event 先于 Projection）；重复→`note.identity_conflict.detected`，不静默覆盖。
6. **Attachment binary backend**：`ctx.fs`（扩展 `writeBytes`）+ workspace 文件 `attachments/<AttachmentId>/...`；**不复用** `ctx.attachments`（图片专用/immutable/identity=sha256）。
7. **Note Move / Attachment Link**：`NoteId` 判定 `note.moved`；rename/move 统一；AST 识别 managed link 定点改写，不碰代码块/URL/普通相对路径。
8. **Note-level signal**：`pkw/note.changed`（高于 `pkw/event.committed`），projection 稳定后 emit，供未来 WeKnora Sync 订阅。
