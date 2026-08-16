# WeKnora Integration — 精确续点（供全新上下文直接继续，勿重复 discovery）

> 用途：上下文耗尽后，新会话/子代理**只读本文件 + 代码**即可继续实现，不必重读全部历史。
> 当前状态：`Implementation in progress`（**不是** Review Gate、**不是** COMPLETE）。

## 0. 如何验证当前状态（先跑，确认基线绿）
```sh
cd /LlHmm9527/Personal Knowledge Workspace
pnpm test        # 期望 30/30 通过（events 6 + workspace 6 + notes 13 + weknora-sync 5）
pnpm typecheck   # 期望 0 错误
```

## 1. 已实现且测试绿（不要再重做）
- **PKW Core**（Phase 1/2，稳定）：`dsh-pkw-domain/events/workspace/notes/attachments`。事实源=Markdown 文件 + workspace binary；NoteIndex/AttachmentCatalog=projection；`ctx.pkwEvents`=durable history。
- **WeKnora Adapter**（`packages/pkw/weknora/src/index.ts`）：`WeKnoraClient`（`ctx.pkwWeKnora`），REST 客户端。已含：`createManualKnowledge/updateManualKnowledge/readManualContent(=GET /knowledge/:id/download)/listKnowledge(分页循环)/getKnowledge/deleteKnowledge/hybridSearch/listKnowledgeBases` + `WeKnoraError(kind)`。
- **WeKnora Sync**（`packages/pkw/weknora-sync/src/index.ts`）：`WeKnoraSyncService`（`ctx.pkwWeKnoraSync`）。domain `pkw_weknora_sync`（`intents` + `mappings` 两表，均含 `workspaceId`）。已含：`syncNote`(create/update/no-op，intent 先于 remote mutation)、`recoverNote`(**CREATE/UPDATE 分流**：update 走 known KnowledgeId readManualContent 比对；create 走分页 list + readManualContent + NoteId/fingerprint 双匹配)、`outcome(error)`（WeKnoraError→known，网络层→unknown）、`mappingKey`（workspace-scoped）。
- **Shared identity parser**：`packages/pkw/domain/src/frontmatter.ts` 的 `parseNoteId`（notes 与 sync 共用，无第二套 regex）。
- **Fake Server**（`packages/pkw/weknora-sync/tests/sync.spec.ts`）：stateful（manual 存储 + download + update + **每页 1 条强制分页**的 list）。

## 2. 已锁定的 WeKnora 0.7.1 契约（勿重复核验）
- Manual Knowledge：payload 仅 `title/content/status/tag_ids/channel/process_config`，**无 metadata/custom_metadata**。
- Manual 原始内容：存于 WeKnora metadata 列，经 `GET /knowledge/:id/download` 返回原始 Markdown。
- `channel`=来源分类（web/api/wechat/feishu/…），`varchar(50)` 无枚举；`channel="pkw"` 作来源分类，**不作 external_id**。
- Knowledge 无 external_id/resource_id（`source_id` 是 Milvus 向量库内部 chunk 标识）。
- File upload 409：`{success:false, code:"duplicate_file", data: existingKnowledge(含 .id), message}` —— `data.id` 是 Attachment 恢复 primitive。
- 认证：`X-API-Key`（主）或 `Authorization: Bearer <JWT>`。
- parse_status raw：`pending/processing/finalizing/completed/failed/cancelled`。
- 实例：本机 `http://127.0.0.1:18088/api/v1`；公网 `https://llhmm9527.duckdns.org:1996/api/v1`；checkout `/LlHmm9527/WeKnora`（0.7.1）。

## 3. 剩余实现（按依赖顺序，这就是续点）
1. **Outcome certainty 二维模型**：把 `outcome()` 升级为「error category × remote outcome certainty」。关键：mutation（create/upload/update）收到 5xx 或网络 timeout 后**不能直接 retry**，需按 operation kind 走 recovery；GET 5xx 可直接 retry；429=known retryable；401/403/400=known permanent；timeout/connection reset after send=unknown。
2. **Multiple-candidate canonical**：create recovery 遇多个 exact fingerprint candidate 时，用稳定规则选 canonical（如 completed 优先 + 稳定 id 排序），其余标 duplicate/stale/superseded（需 durable 表示，不能只 console.warn）。
3. **0-candidate recovery grace**：unknown create 首次 lookup=0 时不立即 create，backoff 重查 N 次后再 create。
4. **Remote fingerprint round-trip**：验证 send↔download 的 sha256 稳定（Unicode/中文/emoji/CRLF/BOM/末尾 newline/quoted/nested frontmatter）。若 WeKnora 会 normalize，定义唯一 `canonicalizeRemoteManualContent()` 两边共用。
5. **Worker / durable dirty / coalescing**：`pkw/event.committed` 只作 dirty hint；durable dirty state（或 needs_sync flag / full-reconcile 兜底）；Worker 用 `ctx.storage` + Cordis `timer`(`ctx.interval`) drain + backoff；重新读 `ctx.pkwNotes.getDocument`（不重放 event payload）；per-entity 序列化 + 跨 entity 并行；restart 主动 resume（dirty/pending/unknown/retryable）。
6. **Attachment Adapter**：`WeKnoraClient` 增 multipart upload + 409 结构化（保留 `duplicateType/existingKnowledge/existingKnowledgeId`，不吞成 generic conflict）+ parse status + reparse/delete。
7. **Attachment Sync**：首次 upload + no-op + unknown(409 `data.id` + sha/metadata 校验) + **安全 replacement**（不 delete-first：upload B → parse completed → 切 active mapping → A 标 stale）+ replacement crash-safe + restore（同 AttachmentId，hash 同 reactivate/no-op，不同走 replacement）。
8. **Full Reconcile**：从 local canonical entities（`ctx.pkwNotes.list` / `ctx.pkwAttachments`）起，比较 mapping/intent/dirty，识别 never-synced/changed/deleted/restored/pending/unknown/retryable/stale/remote-404/replacement-pending，收敛。
9. **Retrieval + SourceRef**：`ctx.pkwWeKnora.search(query,{kbId?,limit?,filter?})`（默认 hybrid-search）；结果 Remote SourceRef（kbId/knowledgeId/chunkId/chunkIndex/score/source）+ 经 workspace-scoped reverse mapping 附加 Local SourceRef（workspaceId/entityType/entityId）；外部 KB 结果 Local 可为空。
10. **Credential wiring**：baseUrl→settings，apiKey→`ctx.credentials`；credential 缺失=integration unavailable（Worker 暂停 remote，不 401 retry storm）；secret redaction 测试（error/log 不含 X-API-Key/Authorization）。
11. **测试补齐**：分布式失败 state-machine 测试（CREATE：request 未达/response 丢/mapping 写 crash/分页/延迟可见/多 candidate；UPDATE：已应用/仍旧版/third-state/B→C；Worker：event 先于 projection ready/丢失/coalesce/per-entity 串行/restart/rate-limit/unknown；Attachment：upload/response 丢/409/replacement 成功/失败保持旧/restart/restore；Reconcile：never-synced/stale/pending/unknown/404/offline→online；Retrieval：mapped/unmapped/workspace-aware；Security：redaction）+ **opt-in real integration suite**（`http://127.0.0.1:18088/api/v1`，无 credential 则 `SKIPPED`）。

## 4. 关键约束（不变量，勿破坏）
- Markdown=Note 事实源；workspace binary=Attachment 事实源；Sync Projection 是唯一 Local↔Remote mapping。
- `WorkspaceId + EntityType + EntityId` 共同定义一切 durable sync identity（mapping/intent/dirty/retry/reconcile/SourceRef reverse）。
- Local Save ≠ Remote Sync（WeKnora offline 不影响 `ctx.pkwNotes.update`/`ctx.pkwAttachments.import`）。
- Durable intent 先于 remote mutation；unknown 先 recovery 不 blind retry；不宣称 exactly-once（真实是 at-least-once + recovery 收敛）。
- Attachment replacement 永远不 delete-first。
- 业务层禁 `node:fs`/`better-sqlite3`；凭证走 `ctx.credentials`，不写 storage/log/event/Markdown/Git。
- Host 不依赖 Agent/Client；本轮不做 Watcher/Widget/IM/Agent Tool/Web UI。

## 5. 目录约定
- PKW 独立项目：`/LlHmm9527/Personal Knowledge Workspace`（pnpm workspace `packages/pkw/*`；vitest 经 `tsconfig.base.json` 的 paths + `baseUrl:/opt/deepseek-harness` 解析 harness 源码；typecheck 用 `tsconfig.json` 解析 harness `lib/types` 声明）。
- 新增 pkw 包时：`tsconfig.base.json` 与 `tsconfig.json` 都要加 `@deepseek-ai/dsh-pkw-<name>` path；包若 import `zod` 需在自身 package.json 声明依赖后 `pnpm install`。
