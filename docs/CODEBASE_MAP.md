# PKW Codebase Map

> 目的：让下一个进入 PKW 的开发 Agent 快速知道"现在到底有哪些东西"。不是 API 百科。
> 基线：Phase 1 CLOSED，产品能力 = Workspace / Notes / Folders / Desktop Editor / Mobile Read-first / Knowledge Home / Unified RAG / Sources(Attachments) / Tasks(Q1–Q4) / Trash。

## 包结构（`packages/pkw/*`，每个 = `@deepseek-ai/dsh-pkw-<name>`）

| 包 | 职责 | 主要入口 | Runtime active |
|---|---|---|---|
| **domain** | runtime-free 领域基础：标识符/OperationContext/DomainEvent、zod domain spec、Markdown 纯函数（footnote/table/editor-commands/lute-pipeline/companion-summary/direct-upload/note-projection） | `src/index.ts` 统一 re-export | ✅（被所有包 import） |
| **events** | `ctx.pkwEvents`：durable 事件库（OperationCommit 原子追加 + 幂等 + post-commit Cordis signal） | `PkwEventStoreService` | ✅ |
| **workspace** | `ctx.pkwWorkspace`：workspace 布局 + `ctx.fs` 路径安全 + OperationContext 工厂 | `PkwWorkspaceService` | ✅ |
| **notes** | `ctx.pkwNotes`：Markdown canonical、NoteIndex 可重建投影、folder CRUD、trash/restore、reconcile | `NotesService` | ✅ |
| **tasks** | `ctx.pkwTasks`：TaskMatrix + Task store（Eisenhower 象限派生，不存储） | `TasksService` | ✅ |
| **attachments** | `ctx.pkwAttachments`：binary canonical + catalog 投影 | `AttachmentsService` | ✅ |
| **weknora** | `ctx.pkwWeKnora`：WeKnora 0.7.1 REST adapter（manual/file/knowledge/搜索/KB/chunks/`getWikiGraph`） | `WeKnoraClient` | ✅ |
| **weknora-sync** | `ctx.pkwWeKnoraSync`：local-first 同步 worker（durable intent/mapping、A2 Processing KB、`searchWithTrace` 检索核心） | `WeKnoraSyncService` | ✅ |
| **web** | `ctx.pkwWeb` Host 插件 + 浏览器 UI；`/pkw` 页面 + `/pkw/api` RPC bridge + `/pkw/attachment` 字节路由 | `PkwWebService`（`src/index.ts`）+ `src/ui.ts` + `src/lute.ts` | ✅ |
| **base** | Host-plane bundle：`cordis.patch.yml` 组合 storage/workspace/pkw 服务 | `cordis.patch.yml` | ✅（由 profile 组合） |

## 关键运行时接线（"谁在真正跑"）

- **RPC**：`web/src/index.ts` 的 `call(method, args)` switch = 全部 UI 能力入口（69 个 method）。UI 只通过 `POST /pkw/api` 调它，从不直接碰 SQLite/fs/WeKnora。
- **Cordis 服务**：`super(ctx, '<name>')` 注册，`inject=[...]` 依赖注入。PKW 服务名：`pkwEvents` / `pkwWorkspace` / `pkwNotes` / `pkwTasks` / `pkwAttachments` / `pkwWeKnora` / `pkwWeKnoraSync` / `pkwWeb`。
- **事件**：`pkw/event.committed`（emit，post-commit 实时信号，非审计日志）。sync worker 监听它标 dirty。
- **Host bundle**：`packages/pkw/base/cordis.patch.yml` 插入 storage / workspace / pkw-events / pkw-workspace 行；`pkw-web` 插件自己 `ctx.plugin()` 挂其余服务。

## Frozen Architecture（不能重新设计）

- Markdown Note = canonical；Attachment binary = canonical；Task Store = canonical。
- Folder = 真实目录 / `relativePath` 派生（无 Folder entity）。
- NoteId / AttachmentId = stable identity（branded id）。
- WeKnora = parsing / indexing / retrieval / derived engine。
- A2 Retrieval = Main Knowledge + Processing Knowledge → Business Knowledge 聚合（`weknora-sync` 的 `searchWithTrace` + `web` 的 `enrichRetrievalResults`）。

## 检索核心（Knowledge = Home + Browse + RAG）

- `weknora-sync.searchWithTrace(query)`：Main KB `hybridSearch` + Processing KB → 聚合去重（businessKey）→ active canonical 过滤 → **纯相对** relevance floor（RRF 分数，非 0..1 cosine）→ 结果 + trace。
- `web` RPC `search` → `{results, trace}`；`enrichRetrievalResults` 只暴露 title/snippet/folder/reason/updatedAt，不暴露 raw chunk/score/knowledgeId/kbId。
- Knowledge Home（无 query）= 最近知识 + 来源概览 + 查看全部；有 query = 检索结果。

## 已移除 / 已收敛（本轮 cleanup 后）

- 见 `docs/CODEBASE_CLEANUP_REPORT.md`。要点：Wiki/Graph **可视化 UI 已删**，仅保留 `getWikiGraph` 边映射供 `relatedKnowledge`（Business Viewer）；DOCX 全删；`resolve`/`tasks-drag`/`markdown-semantics`/`subtask-draft` 四个死模块已删。

## 测试约定

- `pnpm test`（vitest）：单元 + 集成（`integration.spec.ts` 需真实 `WEKNORA_API_KEY` 自跳过）。
- `pnpm typecheck`（`tsc -p tsconfig.json`）。
- 每个 service/纯函数模块有 `tests/*.spec.ts`；HMR/registry 语义靠服务层单测 + `web.spec.ts` 真实 Core 集成（boot 测试用 cordis 组合）。
