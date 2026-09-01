# Post-Closure Sprint Report — Reliability + Desktop Notes + Knowledge Retrieval Cohesion

> 范围：A 可靠性 / B Note→WeKnora 生命周期 / C 知识检索 / D 桌面 Explorer / E 多选批量 / F 附件 URL / G 移动端默认矩阵
> 边界遵守：未改架构、未改 NoteId/AttachmentId/Folder/Task schema、未迁移、未做 Chat Agent、未开始 Phase 2、未 systemctl restart。

---

## Mutation Reliability

### Root Cause（两个叠加，都已修）

1. **Modal overlay 全局选择器（"移动到… 对话框不关闭"的直接原因）**
   `showFolderPicker` / `moveNote` / `quickSwitch` 用 `document.querySelector('.modal-overlay')?.remove()` 和 `[data-act="pick-ok"]` 这类**全局**选择器。连续操作时两个 overlay 叠加，`querySelector` 只移除 DOM 里**第一个** overlay（最底层那个），顶层的留在原地 → "Dialog 未关闭、全页 overlay 锁死"。已改为 `createElement` + 作用域 `overlay.querySelector(...)` 绑定，每个 overlay 只删自己，并补了 backdrop 点击关闭 + `.catch`（listFolders 失败不再静默）。

2. **WeKnora 409 热循环（"操作多了以后越来越慢"）**
   线上日志抓到：`runNoteScopedProcessing` 对 note-scoped 附件（`download_file (1).jpg`）**每 2 秒**向 Processing KB 重复上传，WeKnora 返回 `409 duplicate_file`，但代码没接 `duplicate` 字段 → `processingKnowledgeId` 永远不落盘 → 下个 drain 再传。这是持续的后台空转 + WeKnora 409 刷屏。已改为：409 时 `adopt error.duplicate.id`（与 `uploadAttachment` 同款恢复），热循环消失。

### Local-first 结论

canonical mutation（create/rename/move/trash）在 RPC 层只走 `ctx.fs` + `storageDomain`（本地），**从不 await WeKnora**。确认无回归。UI 提交后只做本地 `renderTree`(getTree) + `refreshHeader`(summary)；WeKnora sync 是后台 `drain`，不阻塞交互。

### Before/After latency

- 未做浏览器级压测（本轮不启动替换服务），故给的是**结构**而非编造的数字：mutation 的 await 链 = `local fs write → durable commit → renderTree → openNote`，每步现在都带 `[pkw.mut]` console.debug 时序（`mutSpan`），`moveNote` 记 pick/getNote/rpc/tree/open，`renameFolder` 记 rpc/tree/paint。真实数字在浏览器 DevTools 直接可见。

---

## WeKnora Lifecycle

### 为什么以前"删除没同步"

实测（`/root/.dsh` 运行时 + WeKnora DB `knowledges` 表）结论：**PKW 一直都在发 DELETE，没漏调用**。主库 `f1b1b498…` 有 50 条 `parse_status='deleting'`（软删已标记 `deleted_at`）。真正的问题是两层：

1. **WeKnora 侧**：`DELETE /knowledge/{id}` 是 **asynq 异步**（200 只代表任务入队），后台 worker 把 chunk/向量清理留在 `deleting` 态没推进 → 用户在 WeKnora 后台看到"还在那里/一直 deleting"。这是 WeKnora 部署侧的异步 worker 问题，不是 PKW 漏删。
2. **PKW 已正确收敛**：`GET /knowledge/{id}` 对软删条目返回 **404**，且 `hybrid-search` 不再返回已删笔记的 chunk。所以 `remoteGone` 判定正确，PKW 在软删后即认为投影已失效。

### 现在 trash/restore 怎么收敛

- **trash**：本地 `notes.delete`（本地先成功）→ 事件 → sync 标 dirty → `runRemoteDelete`：`convergeDeleted`（mapping→`deleted`，保留 reverse 供检索过滤）→ `DELETE` → `GET` 404 → 完成。
- **restore**：`notes.restore` 本地先成功 → 重新走 create/update，`runNoteSync` 读到 `deletedAt` 已清 → 按当前指纹 upsert 回 Main KB，KnowledgeId 可替换、NoteId 稳定。
- **B7 检索过滤 canonical（新增）**：`searchWithTrace` 在 relevance 之前加了本地存在性过滤——本地已删的 Note/Attachment 即使 remote 还在，也不作为 Business Result 暴露。remote eventual consistency 不再泄漏为产品错误。
- **B4 附件不误删**：note 删除只删 Note 的 Main Knowledge 映射，不碰 Attachment binary / Processing Knowledge（独立生命周期）。

---

## Desktop Notes Explorer

- **folder-aware**：Explorer 现在只显示**当前文件夹的直接子文件夹 + 直接子笔记**（root = `''`），不再把全 workspace 摊平。`Folder` 仍是 `relativePath` 派生的真实目录，**未新增 Folder entity**。
- **breadcrumb**：`笔记 / 段 / 段` 每段可点回退 + `↑ 上一级`；左树点文件夹与主视图共用同一 `state.selectedFolder`（`select-folder` 与 `explorer-crumb/explorer-up/explorer-folder` 都走 `renderFolderMain`）。
- **Folder 工具栏**：非 root 显示"文件夹 ⋯"（重命名 / 移入回收站）；新建默认落入**当前** folder（`new-note-here`/`new-subfolder` 都带 `data-path`，不读过期的 `selectedFolder`）。
- **多选/批量（E）**：checkbox + Ctrl/Cmd 点击 toggle + 全选当前 scope + Esc 清空；选中后出现"已选择 N 项 / 全选 / 移动到… / 移入回收站 / 取消"。**复用** `moveNote`/`trashFolder`/`deleteNote`，未新建第二套 mutation；混合选择（父 folder + 内部 note）先 normalize：父 folder 覆盖的 descendant 不重复执行。Marquee 框选 **DEFERRED**（checkbox/Ctrl/Shift/全选已到位，矩形框选需要 geometry hack，本轮不做）。

---

## Attachment URL

### Root cause

写入侧 `uploadVditorFiles` / `companionNoteMarkdown` 把 **raw filename** 拼进 Markdown 目标：`attachments/att_x/download_file (1).jpg`。空格 + 括号在**裸 Markdown 目标**里非法（CommonMark 裸目标不能含空格/不成对括号），于是 Lute/浏览器解析目标被截断 → "无法正确显示"。

### encode / legacy

- 新增 `encodeAttachmentMarkdownPath` / `decodeAttachmentMarkdownPath`（`domain/direct-upload.ts`），并镜像到客户端 `encodeAttachmentPath`。**只 encode 用户 filename 段**，`attachments/<id>/` 前缀与 `/` 分隔符不编码；覆盖 space `()` `#` `?` `%` `&` `+` `[]` 中文 日文 emoji（`encodeURIComponent` 基础上补 `()!*'`）。
- `download_file (1).jpg` → `download_file%20%281%29.jpg`（canonical），UI 仍显示 `download_file (1).jpg`（filename 是显示元数据）。
- **防 double-encode**：只在"从 raw filename 构造 ref"的两处编码，reopen/rerender 不重编码；`decode` 对畸形 legacy `%` 序列返回原样（不 throw）。
- **F4 matcher**：所有 reader（`rewriteAttachmentUrls` / `collectManagedLinks` / `managedAttachmentUrl` / `serveAttachment`）本就**按 AttachmentId 解析、忽略 filename**，所以 legacy raw 引用（含 CJK）继续兼容；展示名取 `AttachmentRecord.filename`。无全库迁移。

---

## Knowledge Retrieval

### 真实 WeKnora API（v0.7.1，`/LlHmm9527/WeKnora`）

- hybrid-search：`POST /knowledge-bases/{id}/hybrid-search`，body `query_text`/`match_count`/`knowledge_ids`——**PKW 字段名全对**。
- delete：`DELETE /knowledge/{id}` 异步返回 `data.task_id`；`POST /knowledge/batch-delete` 存在（PKW 暂按单条删，够用）。
- get：`GET /knowledge/{id}` 对软删条目返回 404。

### 4 个 live query 结果（用真实 key + 真实主库 `f1b1b498…`）

| 查询 | WeKnora 直连结果 | 结论 |
|---|---|---|
| 已知标题「赚钱观念」 | 12 chunks，top score **0.0162**，命中《赚钱观念》《赚钱拆解》 | 召回正确 |
| 不存在词「zzzzzzqqqqqq」 | 9 chunks，top **0.0125**（噪声，WeKnora 不做服务端阈值） | 服务端无强阈值 |
| 已删内容「招贴设计」 | 17 条，全部是未删笔记（已删的软删条目不再返回） | 软删检索隔离正确 |
| `GET /knowledge/{deleting-id}` | **404** | 软删后即视为已消失 |

### 问题在 WeKnora 还是 PKW

**在 PKW**。WeKnora API 本身正常、字段正确。真凶是 PKW 检索的 relevance floor：

```
const floor = Math.max(0.1, top * 0.25)   // 旧
```

WeKnora hybrid-search 的 score 是 **RRF 融合分（rank-based）**，量级 ≈0.016（rank1≈1/61），**不是 0..1 cosine**。硬编码绝对下限 `0.1` 是真实 top score 的 **6 倍**，把所有结果全部滤掉 → "搜索经常搜不到"。已改为**纯相对下限** `top * 0.25`（去掉 0.1 绝对值），并加注释说明 RRF 量级。

### Retrieval Trace（C4，dev 诊断）

`searchWithTrace` 按层打点：`mainRaw → processingRaw → afterBusiness(聚合去重) → afterCanonical(本地存在性) → afterRelevance(相对下限) → final`，server 侧 `[pkw.retrieval]` 一行日志 + RPC 返回 `trace`，UI `console.debug` 打印。搜不到时能定位丢在哪一层。

### Knowledge Home（C5）

无 query 时**不再全库铺卡片**，改为：搜索框 + **最近知识（≤8，按 updatedAt）** + **来源概览（N Notes · N Sources）** + 底部「查看全部知识」；点开才进全量浏览。空结果明确显示「没有找到相关知识」+「查看全部知识」，**不悄悄退回全列表**（C7）。搜索卡片只显示 title / 摘要 / 来源 folder / 命中原因 / 更新时间，**不显示 raw chunk / score / knowledgeId / kbId / HTML**（C6）。**未做 Chat Agent**（C8），未来"问知识"必须复用同一 Retrieval Core。

---

## Mobile Tasks

default-matrix 规则（零 schema，`mobileTaskBoardChosen` 仅内存态）：

1. 当前 session 已有有效选择 → 恢复（`mobileTaskBoardChosen=true` 时不动）。
2. 否则若有用户 TaskMatrix → 默认进**第一个** Matrix（`listMatrices` 已按 `manualOrder` 稳定排序）。
3. 无任何 Matrix 才进 Inbox。
4. 当前 Matrix 被删 → fallback 到下一个 Matrix，否则 Inbox（不进入悬空 matrixId）。

Inbox 保留，仅不再强制成为移动端首页。

---

## Stress Result

未启动替换服务做浏览器级压测（范围约束），以**真实运行时观测**代替：
- 抓到并消除 WeKnora 409 热循环（此前每 2s 空转一次上传）。
- modal overlay 作用域化后，叠加 overlay 不再互相锁死。
- 全量测试 309 passed / 0 failed（见下）。
- 生产浏览器级 smoke（20~30 连续 mutation）留给部署后验证——这是本轮明确未跑的项。

---

## Tests

- `pnpm test`（vitest）：**309 passed / 5 skipped / 0 failed**（5 skipped = `integration.spec.ts` 需要真实 `WEKNORA_API_KEY` 的自跳过）。
- 新增 `direct-upload.spec.ts`：`encodeAttachmentMarkdownPath`/`decodeAttachmentMarkdownPath` 的 space/()/#/?/%/&/+/[]/CJK/emoji、`/` 分隔保留、round-trip、畸形 `%` 容错、companionNoteMarkdown 编码。
- 更新 `web.spec.ts` 4 处契约断言：search RPC 返回 `{results, trace}`、companion note 引用编码。
- `tsc -p tsconfig.json`（PKW 自身）：exit 0。

---

## Debt

> 收敛于 docs/DEBT.md

1. **harness 严格 typecheck 报 PKW 既有 `exactOptionalPropertyTypes` 错误**（`attachments/events/notes/frontmatter` 等，共 ~20 处），是 PKW 在 harness 的 `tsconfig.host.json` 下**未过严格可选属性检查**的既有债，与本轮改动无关；PKW 自身 tsconfig 全绿。建议后续专项收紧。
2. `weknora-sync` 的 `multiple exact candidates → deterministic canonical` 测试在一次运行中出现非确定性失败（本机 stash 到 HEAD 复现过，当前运行通过），疑似 fake adapter 顺序相关 flaky，未归因，留待加固。
3. **WeKnora 侧 50 条 Knowledge 停在 `deleting`**：asynq 异步删除 worker 未完成 chunk/向量清理，PKW 无法代偿（软删 + 404 + 检索隔离已正确）。这是 WeKnora 部署运维项。
4. Marquee 框选 DEFERRED（E2）。
5. 浏览器级压测（Part H）未在本轮执行。

---

## HEAD

`3eb016a` docs: Phase 1 closure — freeze architecture, decisions, debt

变更文件：
- `packages/pkw/weknora-sync/src/index.ts` — RRF 相对下限、`searchWithTrace` + RetrievalTrace、note-scoped 409 恢复、B7 canonical 过滤
- `packages/pkw/web/src/index.ts` — search RPC 返回 `{results, trace}`
- `packages/pkw/web/src/ui.ts` — overlay 作用域化、`mutSpan` 时序、Knowledge Home、folder-aware Explorer + breadcrumb + 多选批量、附件路径编码、移动端默认 Matrix
- `packages/pkw/domain/src/direct-upload.ts` + `index.ts` — encode/decode 附件路径 helper
- `packages/pkw/domain/tests/direct-upload.spec.ts`、`packages/pkw/web/tests/web.spec.ts` — 契约/单测更新

STOP。
