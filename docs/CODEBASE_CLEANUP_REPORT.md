# PKW Codebase Cleanup Report

> 模式：POST-CLOSURE MAINTENANCE + SAFE DEAD CODE CLEANUP。
> 原则：只删 HIGH-CONFIDENCE dead code；有动态引用/运行时/测试/兼容职责的一律 DEFER；不重写、不重构、不改架构。

## 分类总览

| Area | Finding | Status | Evidence | Action |
|---|---|---|---|---|
| Wiki UI | `renderWikiList` / `wikiSearch` / `openWikiPage` / `renderGraphView` / `drawGraph` / `graphColor` + `knowledge-tab/wiki-folder/back-wiki/open-wiki-page/graph-*` actions + state `knowledgeTab/wikiFolder/graphTypes` | SAFE DELETE | `renderKnowledgeView()` 从不按 tab 分派到 wiki/graph；无任何 UI 入口调用这些函数 | removed |
| Wiki adapter | `listWikiPages` / `getWikiPage` / `listWikiFolders` / `getWikiStats` + types `WikiPage/WikiPageList/WikiFolder/WikiFolderList/WikiStats` | SAFE DELETE | 仅被已删 RPC/UI 调用；`grep` 全仓无消费者 | removed |
| Graph edge mapping | `getWikiGraph` + `WikiGraphNode/Edge/Data` + RPC `relatedKnowledge` | **ACTIVE** | `relatedKnowledge` 被 Business Knowledge Viewer（`#relatedKnowledge`）调用，读 graph edge 映射 neighbor→本地笔记 | keep |
| DOCX | `docx-note.ts`（`createDocxNote/compileProcessingDocx/extractDocxText/readDocxNoteId/writeDocxNoteId`）+ `docx`/`jszip` deps | SAFE DELETE | 无 RPC/服务/sync 任何运行时入口，仅自测 + index re-export（DOCX primary transport 已冻结拒绝） | removed |
| deps | `chokidar`、`fast-xml-parser` | SAFE DELETE | 源码零 import（chokidar 仅一处 JSDoc 注释；fast-xml-parser 零引用） | removed |
| 死模块 | `resolve.ts`（`resolveTextQuoteAnchor`）、`tasks-drag.ts`（`resolveTaskDrop/isReorderOnly`）、`markdown-semantics.ts`（4 parse 函数）、`subtask-draft.ts`（8 exports） | SAFE DELETE | 全部零运行时消费者（仅各自 spec + index re-export）；harness 无 `dsh-pkw` 外部引用 | removed |
| tasks-view | `filterTasksForView`（`quadrantOf` 保留） | SAFE DELETE | 视图聚合已在 UI 客户端 `filterTaskList` 实现，domain 版零调用 | removed |
| trash | `deriveSelectAll` / `reconcileSelection` / `trashItemKey`（`parseTrashItemKey/summarizeBatch` 保留） | SAFE DELETE | web 仅 import `parseTrashItemKey/summarizeBatch`；选择推导在客户端 | removed |
| companion-summary | `managedSourceProjection`（其余保留） | SAFE DELETE | 零运行时消费者；`companionUserContent` 保留（被 `hasCompanionUserContent` 内部使用） | removed |
| adapter 死方法 | `cancelParse` / `listKnowledgeBases` | SAFE DELETE | 零调用（无 RPC、无 sync、无测试） | removed |
| CSS | `#search`（旧 header search）、`.graph-legend-item` | SAFE DELETE | 页面无 `id="search"` 元素；graph legend 随 graph UI 删除 | removed |
| i18n | 15 个 wiki/graph key（`knowledgeWiki`…`graphUnavailable`） | SAFE DELETE | `t('<key>')` 全仓 0 引用 | removed |

## Removed（为什么 100% 确认 dead）

- **DOCX 全链**：`docx-note.ts` + spec + `docx`/`jszip` 依赖。DOCX 曾作为 primary transport 的 POC 被冻结决策否决（Markdown canonical 胜出）；当前 A2 管线直接把附件作为独立 File Knowledge 上传，不再编译 processing.docx。
- **Wiki / Graph 可视化**：完整 UI + 5 个 RPC + 4 个 adapter 方法 + 类型 + i18n + CSS + state。`renderKnowledgeView` 已经只处理 Home/Browse/Search，从不渲染 wiki/graph。
- **4 个死 domain 模块**：`resolve`、`tasks-drag`、`markdown-semantics`、`subtask-draft`。它们的职责都已被客户端（ui.ts 内联）或其它模块接管，全仓（含 `/opt/deepseek-harness`）零 import。
- **6 个活模块内的死 export**：`filterTasksForView`、`deriveSelectAll`、`reconcileSelection`、`trashItemKey`、`managedSourceProjection`，及 `cancelParse`/`listKnowledgeBases`。
- **依赖**：`chokidar`、`docx`、`fast-xml-parser`、`jszip`（domain 只剩 `zod`）。

## Kept（看似历史代码，但必须保留）

- **`getWikiGraph` + graph 类型 + `relatedKnowledge`**：Graph 可视化没了，但 graph **edge 映射**仍是 Business Knowledge Viewer 的"相关知识"来源，属于仍有价值的 relation capability。
- **`WeKnoraClient.fingerprintManualContent` / `fingerprintFile`**：测试用契约 helper，验证 adapter 指纹与远端一致（sync 恢复逻辑的正确性依赖）。
- **`companionUserContent`**：被 `hasCompanionUserContent`（weknora-sync 用于 Companion Note 去重）内部调用，非死代码。
- **`quadrantOf` / `parseTrashItemKey` / `summarizeBatch` / direct-upload helpers**：当前产品直接使用。

## Deferred（可疑但暂不删）

> 收敛于 docs/DEBT.md

- 未使用的 domain **类型声明**（若干 interface/type）：删除价值低、且类型契约边界易误伤，本轮不逐一处理，记 DEBT。
- `// Header global search removed` 注释：保留作为"为什么没搜索框"的历史说明。
- **WeKnora deleting/asynq 停摆**（上轮 OPS DEBT）：WeKnora 侧异步删除 worker 未完成 chunk 清理，非 PKW 代码，不改 worker。
- **Wiki/Graph 作为 Derived Knowledge Context DEBT**：WeKnora 仍在生成 wiki/graph 数据，PKW 只消费 edges；若未来要彻底下线需在 WeKnora 侧关闭。

## Metrics（cleanup 前后）

| 指标 | Before (HEAD `9d4421a`) | After | Δ |
|---|---|---|---|
| src 文件数（非 tests） | 32 | 27 | -5 |
| src 代码行数 | 11 906 | 11 181 | -725 |
| test 代码行数 | 4 194 | 3 762 | -432 |
| domain 外部依赖 | 5 (chokidar/docx/fast-xml-parser/jszip/zod) | 1 (zod) | -4 |
| 全包外部依赖 | — | 2 (zod, vditor) | — |
| RPC 数量 | 74 | 69 | -5 |
| route 数量 | 4 (/pkw, /pkw/api, /pkw/attachment, /pkw/assets/vditor) | 4 | 0 |
| 移除 dead exports | — | ~25 函数 + ~8 类型 | — |

> 注：数字是粗量级，目标是确认 cleanup 确实发生，不是追求 LOC 数字。

## 验证

- `pnpm typecheck`：exit 0
- `pnpm test`：**253 passed / 0 failed**（5 skipped = `integration.spec.ts` 需真实 key）
- `git diff --check`：无 whitespace 错误
- runtime smoke：`pkw-web` Host 插件类型通过（`PkwWebService` + RPC `call()` switch 无悬空 case）；Wiki/Graph/DOCX 删除未触碰 `/pkw` 路由、Notes/Knowledge/Sources/Tasks/Trash RPC。
