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
- `web` RPC `search` → `{results, trace}`；`enrichRetrievalResults` 提供稳定本地身份、title/snippet/folder/reason/updatedAt，并保留 `remote.content` 与 `remote.score` 兼容字段；检索结果剥离 remote knowledgeId/kbId/chunkId。UI 展示清理后的摘要片段，不把内部打分当作相关性保证。
- Knowledge Home（无 query）= 最近知识 + 来源概览 + 查看全部；有 query = 检索结果。

### 检索已知限制（当前未修，留给 agent 化）

> 收敛于 docs/DEBT.md

**现象**：搜「潘帕斯」等罕见词，第 1 条正确，但后面若干条与词无关（来源同 folder、标「正文命中」）。

**根因链**（不是数据/聚合 bug）：
1. **WeKnora `hybrid-search` 无服务端阈值**——必回 `match_count` 个 chunk；sprint 实测不存在的词「zzzzzzqqqqqq」也回 9 条噪音（top≈0.0125），真词「赚钱观念」top≈0.0162。真假分数**重叠**，用任何绝对/相对下限都无法干净切分。
2. **PKW 相对下限 `top * 0.25` 是 no-op**：RRF 融合分簇集在窄带，`top*0.25` 基本保留 WeKnora 返回的全部 chunk（旧绝对下限 `0.1` ↑6 倍会把所有结果滤掉，已被去掉；现在矫枉过正到近乎不滤）。
3. **「正文命中」标签曾有误导**：旧 `searchCardsHtml` 对 main-KB note 命中默认标正文命中。本轮已改为说明检索来源，不能据此推断真实相关性已有提升。

**正确修法**：需要一个真正的 reranker / LLM（agent 化）相关性闸门，而不是调阈值。**本轮不修**（避免重蹈「搜不到」回归）；留给未来检索 agent 化。

## 已移除 / 已收敛（本轮 cleanup 后）

- 见 `docs/CODEBASE_CLEANUP_REPORT.md`。要点：Wiki/Graph **可视化 UI 已删**，仅保留 `getWikiGraph` 边映射供 `relatedKnowledge`（Business Viewer）；DOCX 全删；`resolve`/`tasks-drag`/`markdown-semantics`/`subtask-draft` 四个死模块已删。

## 测试约定

- `pnpm test`：先运行 Node 工具测试，再运行 Vitest 单元 + 集成（`integration.spec.ts` 需真实 `WEKNORA_API_KEY` 自跳过）。
- `pnpm typecheck`：通过脚本应用 `DSH_HARNESS_ROOT` 后运行 TypeScript 检查。构建、重复产物核验与真实包安装检查见 [BUILD_AND_DEPLOY.md](BUILD_AND_DEPLOY.md)。
- 每个 service/纯函数模块有 `tests/*.spec.ts`；HMR/registry 语义靠服务层单测 + `web.spec.ts` 真实 Core 集成（boot 测试用 cordis 组合）。
