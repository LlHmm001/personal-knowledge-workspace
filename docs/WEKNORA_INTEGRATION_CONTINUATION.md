# WeKnora Integration — 精确续点（供全新上下文直接继续，勿重复 discovery）

> 用途：上下文耗尽后，新会话/子代理**只读本文件 + 代码**即可继续实现，不必重读全部历史。
> 当前状态：**Core Integration 实现完成，进入 Review Gate 前收尾**（不是 Capability Discovery，不是 Architecture Design）。

## 0. 当前 Git 基线（先跑，确认绿）
```sh
cd /LlHmm9527/Personal Knowledge Workspace
git log --oneline -2   # a0bb117 (core integration) → 011138b (Phase 1/2 base)
pnpm test              # 期望 61 passed + 5 skipped（integration 无 credential 时 skip）
pnpm typecheck         # 期望 0 错误
```

- **HEAD**：`a0bb117` — `feat(weknora): core integration — outcome model, durable dirty + worker, attachment sync + safe replacement, reconcile, retrieval + SourceRef, credential wiring`
- **Harness**：`4c95665`（Phase 2A FileSystem substrate，未变）。PKW 侧仅在 `tsconfig.base.json` / `tsconfig.json` 加了 `@deepseek-ai/cordis-plugin-timer` path 映射；**未改 Harness checkout**。

## 1. 已实现且测试绿（不要再重做）
- **WeKnora Adapter**（`packages/pkw/weknora`）：
  - `WeKnoraClient`：manual create/update/download、`listKnowledge`(分页循环)、`getKnowledge`(全字段含 parse_status/file_hash)、`deleteKnowledge`、`reparseKnowledge`、`cancelParse`、`hybridSearch`（**已修正为 `query_text` + `match_count`**）、`listKnowledgeBases`。
  - `uploadFile`：multipart（`file`/`channel`/`metadata`）；409 `duplicate_file` 结构化保留 `err.duplicate`（含 `id`/`file_hash`），不吞成 generic conflict。
  - `WeKnoraError`（`kind/status/code/body/duplicate`）+ `WeKnoraNotConfiguredError`。
  - Credential：`Config{baseUrl, apiKey, apiKeyRef}`；`apiKeyRef` 经 `ctx.credentials.resolve` 每次请求解析；`credentialStatus()`；`redactSecrets()`。
  - `src/fingerprint.ts`：`remoteManualFingerprint`(sha256 of canonicalized content)、`sha256Bytes`、`md5Bytes`（= WeKnora `file_hash`）、`canonicalizeRemoteManualContent`（当前 identity；`readManualContent` 用 `TextDecoder(ignoreBOM:true)` 读原始字节以保留 BOM）。
- **Outcome model**（`weknora-sync/src/outcome.ts`）：`classifyOutcome(error,{mutation})` → `{category: permanent|retryable|unknown, certainty: known|unknown}`。mutation 5xx/timeout=unknown；GET 5xx=retryable；429=retryable；401/403/400/404/409=permanent。
- **Sync**（`packages/pkw/weknora-sync`，domain `pkw_weknora_sync` v2，表 `intents/mappings/dirty/reverse`，全部 workspace-scoped）：
  - Durable Dirty：`pkw/event.committed` 只 markDirty（`workspaceId:entityType:entityId` key）；Worker 读当前 canonical local state，不 replay 历史。
  - Worker：`ctx.interval` drain + init 时立即 drain（restart resume 扫 intents+dirty）；per-entity in-process 串行锁 + 跨 entity 并行；backoff；permanent 清 dirty 停 retry。
  - Manual：create/update/no-op；CREATE unknown→candidate enumeration（NoteId+fingerprint）→0-candidate grace→re-create / 1-exact recover / multi-exact deterministic canonical（completed 优先 + 稳定 id 排序，其余记 `supersededKnowledgeIds`，不 delete）；UPDATE unknown→readManualContent(known id) 比对；remote 404→safe recreate。
  - Attachment：first upload / 409(verify `file_hash`)+claim / safe replacement（upload B → parse completed → switch → A superseded，**不 delete-first**）/ replacement crash resume / restore（同 id 同 hash reactivate，异 hash replacement）；parse status 单独维度不阻塞其他 entity。
  - Full Reconcile：从 local canonical entities（notes.list + attachments.list）收敛 never-synced/changed/deleted/restored/stale → markDirty/markDeleted。
  - Retrieval：`sync.search(query,{kbId?,limit?,knowledgeIds?})` → Remote SourceRef（kbId/knowledgeId/chunkId/chunkIndex/score/title/filename/source/channel）+ 经 `reverse` 表附 workspace-correct Local SourceRef（外部 KB 结果 local=undefined）。
- **Attachments core**：`PkwAttachmentsService.list(filter?)` 已加（full reconcile 需要）。
- **测试**：stateful fake server（manual+file、multipart、分页、delayed visibility、commit-then-drop / drop-before-read / 5xx / 429 / 409、parse status、hybrid-search）+ 36 个分布式失败测试（outcome model、fingerprint round-trip、CREATE/UPDATE/WORKER/ATTACHMENT/RECONCILE/RETRIEVAL/SECURITY、credential wiring+unavailable、restore、replacement crash）。`tests/integration.spec.ts` 为 opt-in real suite（无 credential → 5 skipped）。

## 2. 已锁定契约（勿重复核验，同前）
- Manual payload 仅 `title/content/status/tag_ids/channel/process_config`；原始内容存 metadata 列，`GET /knowledge/:id/download` 返回原始 Markdown（application/octet-stream）。
- File upload：`POST /knowledge-bases/:id/knowledge/file`，multipart `file`(+`fileName`/`channel`/`metadata`/`enable_multimodel`/`tag_ids`/`process_config`)；409 `{success:false, code:"duplicate_file", data:existingKnowledge(含 .id 与 .file_hash), message}`；`file_hash` 是 **MD5**（非 sha256）。
- parse_status raw：`pending/processing/finalizing/completed/failed/cancelled`。
- hybrid-search：`POST /knowledge-bases/:id/hybrid-search`，body `query_text`+`match_count`(+可选 `knowledge_ids`)；返回 `SearchResult[]`（`id=chunk id`、`knowledge_id`、`chunk_index`、`score`、`knowledge_title/filename/source/channel`）。
- 认证：`X-API-Key`（主）或 `Authorization: Bearer <JWT>`。
- 实例：本机 `http://127.0.0.1:18088/api/v1`；checkout `/LlHmm9527/WeKnora`（0.7.1）。

## 3. 剩余（收尾 / Review Gate 前置，很小）
1. **Lint**：PKW 仓库当前无 lint 脚本/配置（只有 `test`+`typecheck`）。Review Gate 定义里含 Lint —— 若需要，补一个最小 eslint/或明确记录“本项目以 typecheck+tests 为门禁”。
2. **Real Integration 实跑**：`WKNORA_API_KEY`+`WKNORA_TEST_KB_ID`（+可选 `WKNORA_BASE_URL`）注入后跑 `tests/integration.spec.ts`（Manual create/list/download/update、File upload、409 `data.id`、parse status、hybrid search）。API Key 只经 env/Harness credential 注入，**不进聊天/不进 Git**。
3. **已知性能/UX 债**（非 correctness blocker）：
   - `reconcile()` 对每个 attachment 调 `open()`（读全量 bytes）算 sha256；大文件慢，可后续用 catalog 的 `sha256` 字段短路（仅当 `observedRevision`/stat 变化才重读）。
   - Manual create recovery 每次 `listKnowledge` 全 KB 拉取 + 逐条 `readManualContent`；KB 很大时慢，可后续按 `channel=pkw`/`source=manual` 过滤或加 `metadata` 后门。
   - intent 非终端态扫描按 O(intents) 在 drain 里做；量级大时可加 per-entity 索引。
   - `syncNote`/`syncAttachment` 直接调用时对 unknown 结果 throw（`did not converge`）；调用方需自行走 worker/drain 收敛。

## 4. 关键约束（不变量，勿破坏，同前）
- Markdown=Note 事实源；workspace binary=Attachment 事实源；Sync Projection 是唯一 Local↔Remote mapping。
- `WorkspaceId + EntityType + EntityId` 定义一切 durable sync identity（key 前缀即 workspace；reverse 表 record 带 workspace）。
- Local Save ≠ Remote Sync（WeKnora offline 不影响 local save）。
- Durable intent 先于 remote mutation；unknown 先 recovery 不 blind retry；at-least-once + recovery 收敛。
- Attachment replacement 永不 delete-first。
- 业务层禁 `node:fs`/`better-sqlite3`；凭证走 `ctx.credentials`，不写 storage/log/event/Markdown/Git；错误/lastError 经 `redactSecrets`。
- Event 只标脏；Worker 读当前 canonical Local State；Full Reconcile 兜底。
- KnowledgeId = Remote Projection，不是 Local Identity。

## 5. 目录约定（同前）
- PKW 独立项目 `/LlHmm9527/Personal Knowledge Workspace`（pnpm workspace `packages/pkw/*`；vitest 经 `tsconfig.base.json` paths + `baseUrl:/opt/deepseek-harness` 解析 harness 源码；typecheck 用 `tsconfig.json` 解析 harness `lib/types`）。
- `@deepseek-ai/cordis-plugin-timer` 已在两处 tsconfig 映射（`vendor/timer/src` 与 `vendor/timer/lib/types`）；sync service 以 `import type {}` 引入其 `ctx.interval` augmentation，并 `inject: ['timer']`。
- 新增 pkw 包时：`tsconfig.base.json` 与 `tsconfig.json` 都要加 path；包若 import `zod` 需在自身 package.json 声明依赖后 `pnpm install`。

## 6. 下一步
进入 **# WeKnora Core Integration Review Gate**：跑全量回归 + typecheck（+可选 lint/real integration），逐项核对第 3 节剩余项，然后按「最终汇报」模板（架构/packages/commits/隔离/适配器/凭证/outcome/intent/mapping/dirty/recovery/fingerprint/worker/并发/重试/附件/409/replacement/restore/reconcile/remote-missing/parse/retrieval/SourceRef/fake 测试/real 测试/secret/全量测试/typecheck-lint/blocker/debt/下一步）一次性中文汇报。
