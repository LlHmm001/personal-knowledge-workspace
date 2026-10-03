# WeKnora Integration — 当前状态 / Operations / Remaining Debt

> 状态：**# WeKnora Core Integration COMPLETE**（已通过真实实例验收）。
> 本文件是项目长期状态记忆：新上下文只读本文件 + 代码即可续接，不必重读历史。

## 1. 当前 Git 基线
```sh
cd /LlHmm9527/Personal Knowledge Workspace
git log --oneline -4
pnpm test        # 62 passed + 5 integration skipped（无 credential 时）
pnpm typecheck   # 0 错误
```

- **HEAD**：`602c161` — `fix(weknora): real-instance contract — manual publish status, CleanMarkdown canonicalization, file_hash duplicate verification`
- 提交链：`602c161`（real contract fix）→ `2db2841`（docs）→ `a0bb117`（core integration）→ `011138b`（Phase 1/2 base）
- **Harness**：`4c95665`（Phase 2A FileSystem substrate，未变）。PKW 仅在两个 tsconfig 加 `@deepseek-ai/cordis-plugin-timer` path 映射，未改 Harness checkout。

## 2. 真实实例验收（已完成）
- **实例**：WeKnora 0.7.1 @ `http://127.0.0.1:18088/api/v1`（checkout `/LlHmm9527/WeKnora`）。
- **专用 KB**：`PKW Personal Knowledge`，`KB_ID = f1b1b498-5162-4500-b477-485f853c39a3`（tenant_id 10000）。程序只依赖 KB ID，不依赖名称。
- **验收结果**：`tests/integration.spec.ts` 5/5 通过（Manual create→list/download round-trip、update、File upload、duplicate 409 + data.id + file_hash、parse_status、hybrid-search）。
- **复杂 Markdown round-trip 已验证**：CJK、emoji、quoted frontmatter title、nested unknown field、CRLF、leading BOM 全部 `download == sent`（`readManualContent` 用 `TextDecoder(ignoreBOM:true)` 读原始字节）。

### 真实契约修正（相对早期锁定，重要）
1. **Manual 必须 `status:"publish"`**：否则 WeKnora 存为 `draft`（parse_status `draft`、不索引、不可检索）。Adapter 的 `createManualKnowledge`/`updateManualKnowledge` 现在始终带 `status:"publish"`。
2. **`secutils.CleanMarkdown`（XSS strip）**：WeKnora 在 create/update 时对 manual content 执行 XSS 正则清理。`canonicalizeRemoteManualContent()` 精确复刻这 16 条正则，send/recovery 两侧指纹一致（幂等）。
3. **parse_status raw 集合**：实际还含 `draft` 与 `deleting`（早期只列 pending/processing/finalizing/completed/failed/cancelled）。Adapter/Sync 原样保存，不 collapse 成 ready。
4. **file_hash = MD5**（非 sha256）：duplicate 409 的 `data.file_hash` 与 `md5Bytes(上传 bytes)` 精确相等（已断言），这是 Attachment 409-recovery 的验证 primitive。

## 3. 已实现能力清单（不要再重做）
- **Adapter**（`packages/pkw/weknora`）：manual create/update/download、`listKnowledge`(分页循环)、`getKnowledge`、`deleteKnowledge`、`reparse`/`cancelParse`、`uploadFile`(multipart + typed 409 `err.duplicate{id,file_hash}`)、`hybridSearch`(`query_text`+`match_count`)、`listKnowledgeBases`；`credentialStatus`/`redactSecrets`；`fingerprint.ts`(remote manual sha256 + `md5Bytes`/`sha256Bytes` + `canonicalizeRemoteManualContent`)。Config `{baseUrl, apiKey, apiKeyRef}`。
- **Outcome model**（`weknora-sync/src/outcome.ts`）：`classifyOutcome(error,{mutation})` → category(permanent/retryable/unknown) × certainty(known/unknown)。
- **Sync**（`weknora-sync`，domain `pkw_weknora_sync` v2，表 intents/mappings/dirty/reverse，全部 workspace-scoped）：durable dirty + worker（`ctx.interval` drain + init resume，读当前 canonical state 不 replay）、coalescing、per-entity 串行锁、backoff、permanent 停 retry；Manual create/update/no-op + CREATE unknown(候选枚举 NoteId+fingerprint → 0-candidate 保留原 intent 并按 nextRetryAt 退避查找，不据列表缺失重造；只有明确 known rejection 可在 grace 后重试 / 1-exact / multi-exact deterministic canonical + superseded 记录不 delete) + UPDATE unknown(readManualContent 比对) + remote 404 recreate；Attachment upload / 409 verify file_hash / safe replacement(不 delete-first) / replacement crash resume / restore(同 hash reactivate)；Full Reconcile；Remote Missing；parse status 独立维度；Retrieval `search()` + Remote SourceRef + workspace-correct Local SourceRef(via reverse 表)。
- **Credential**：`apiKeyRef` 经 `ctx.credentials.resolve` 每请求解析；缺失 → `WeKnoraNotConfiguredError`/integration `unavailable`（worker 暂停，无 401 retry storm）；local save 不受影响。
- **测试**：stateful fake server（multipart/分页/延迟可见/lost-response/429/5xx/409/parse status/hybrid-search）+ 62 个分布式失败测试（outcome model、fingerprint round-trip、canonicalization、CREATE/UPDATE/WORKER/ATTACHMENT/RECONCILE/RETRIEVAL/SECURITY、credential+unavailable、restore、replacement crash）。

## 4. 配置模型（Operations）
- **Base URL**：可配置（同机 `http://127.0.0.1:18088/api/v1`；公网 `https://llhmm9527.duckdns.org:1996/api/v1` 留作未来跨机）。不进 domain logic。
- **KB ID**：`WeKnoraSyncService` config `kbId`；测试读 env `WEKNORA_TEST_KB_ID`。
- **API Key**：只走 `ctx.credentials`（`apiKeyRef`）或 `apiKey`（纯 DI/test）。**不进 Git / Markdown / event / log / 聊天**；错误与 `lastError` 经 `redactSecrets`。
- **真实 integration test 运行方式**（opt-in，无 credential 自动 SKIP）：
  ```sh
  WEKNORA_API_KEY=<secret> WEKNORA_TEST_KB_ID=<kbId> \
    pnpm vitest run packages/pkw/weknora-sync/tests/integration.spec.ts
  ```
  测试只创建/清理 `pkw-it*` 前缀自己的 Knowledge（WeKnora delete 是 soft-delete），绝不删 KB/用户数据。env 前缀统一为 `WEKNORA_`（项目 convention，无 typo）。
- **WeKnora 上无 API Key 时**：在 WeKnora UI「设置 → API Keys」生成 full_access tenant key 注入 credential；或（本地验证时）经 DB `tenant_api_keys` 临时生成后即删。

## 5. 不变量（勿破坏）
- Markdown=Note 事实源；workspace binary=Attachment 事实源；Sync Projection 是唯一 Local↔Remote mapping。
- `WorkspaceId + EntityType + EntityId` 定义一切 durable sync identity。
- Local Save ≠ Remote Sync（WeKnora offline 不影响 local save）；durable intent 先于 mutation；unknown 先 recovery 不 blind retry；at-least-once + recovery 收敛。
- Attachment replacement 永不 delete-first。
- Event 只标脏；Worker 读当前 canonical Local State；Full Reconcile 兜底；KnowledgeId 是 Remote Projection 非 Local Identity。
- 业务层禁 `node:fs`/`better-sqlite3`；凭证只走 `ctx.credentials`；Host 不依赖 Agent/Client。

## 6. Remaining Debt（非 correctness blocker）

> 收敛于 docs/DEBT.md

- **Lint/tooling**：PKW repo 无独立 lint 配置；当前质量门禁 = `tsc strict` + tests（+ Harness pre-commit 对 substrate patch）。属 tooling debt，非 WeKnora correctness blocker，本轮未引入大型 ESLint 工具链。
- **性能**：`reconcile()` 对每个 attachment 全量 `open()` 算 sha256（可改 catalog.sha256 短路）；manual CREATE recovery 全 KB list+download（可后续按 `channel=pkw`/source 过滤）；drain 扫 intents O(n)（可加 per-entity 索引）。
- **Neo4j**：验收期间发现本机 WeKnora app 曾因 Neo4j data volume 与 `.env` 密码不一致而 crash-loop（RestartCount 增长后恢复，manual create 一度 502，后自愈/稳定）。这是 WeKnora 部署问题，非 PKW 缺陷；若复发需在 WeKnora 侧对齐 neo4j 密码。

## 7. 下一步
停在 **WeKnora Core Integration Review Gate（已 COMPLETE）**。下一阶段再共同决定 Facts/PLL、Tasks、Relations、Agent Tool、Context Compiler、Watcher、WeKnora MCP、Widget、IM（微信/WeCom/Feishu）、Web UI 的优先级。本轮**不自动进入**这些实现。
