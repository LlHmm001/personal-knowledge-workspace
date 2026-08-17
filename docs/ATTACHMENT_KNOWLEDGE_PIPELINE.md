# Attachment → Note → WeKnora Knowledge Pipeline

Status: **audit record** (verified from PKW + WeKnora source, not assumptions). This is the CURRENT/TARGET/GAP/OPTIONS/RECOMMENDATION doc that gates any ingestion change (PART L).

## Canonical invariants (unchanged)

- **Markdown Note** = canonical textual knowledge (`NoteId` stable).
- **Attachment binary** = canonical file (`AttachmentId` stable, `att_<12hex>`).
- **WeKnora** = retrieval/index **projection** only — it never owns PKW's raw facts.

---

## 1. Note 插入附件 — 真实数据路径 (C1)

```
Live Editor (Vditor IR) upload / insert
  → browser uploadVditorFiles → api('uploadAttachment', {filename, mimeType, contentBase64})
  → web bridge uploadAttachment → attachments.importFile()
  → binary 写到 workspace filesystem: attachments/<AttachmentId>/<filename>   ← binary 真身
  → AttachmentId = att_<12 hex>   (importFile 时创建)
  → Markdown 写入 canonical reference:
        image:  ![](attachments/<AttachmentId>/<filename>)
        file:   [filename](attachments/<AttachmentId>/<filename>)
  → vditor.insertValue(reference) → 随 Note body autosave 保存
```

**Note ↔ Attachment 关系 = 完全由 Markdown 解析派生**（`collectManagedLinks`，跳过 fenced/inline code，匹配 `attachments/<id>/...` 链接/图片目标）。**没有**结构化 relation 表。这是 by-design 的轻量 projection。

---

## 2. Note → WeKnora 同步 payload (C2)

- 路径：`weknora-sync.runNoteSync` → `createManualKnowledge(kbId, { title, content: markdown })`。
- **payload = 原始 Markdown 字符串**（不是 rendered HTML、不是纯文本、不是文件）。
- `NoteId ↔ KnowledgeId` 映射持久化在 PKW 的 `mappings` 表（durable），带 sha256 指纹 + 修订追踪。
- 关键：WeKnora 对 manual knowledge 走 **文本分块**，**不会** follow Markdown 里的 `/pkw/attachment/<id>` 去读 binary。

---

## 3. 附件库直接上传 — 真实路径 (C4)

```
Attachment Library → api('uploadAttachment') → attachments.importFile()
  → 本地 binary 保存（同 §1）
  → 这是 local canonical save，NOT WeKnora upload
```

- WeKnora 上传是**异步**的：sync worker 把 dirty 的 attachment 通过 `runAttachmentSync` → `uploadFile(kbId, {content: bytes, filename, mimeType, channel:'pkw'})` 上传。
- **`AttachmentId ↔ KnowledgeId` 映射已存在**（`getAttachmentMapping` / `mappings` 表，durable，含 MD5 去重 + sha256 指纹 + replacement/recovery）。

所以 **Attachment 已经独立进入 WeKnora**（作为 file ingestion，而非只存本地 binary）。

---

## 4. WeKnora parser 选择 (C5) — 从源码证明

`/LlHmm9527/WeKnora`：

- `internal/application/service/knowledge_util.go:34` `getFileType(filename)` = 文件名最后一段小写扩展名。
- `internal/types/knowledgebase.go:211` `ChunkingConfig.ResolveParserEngine(fileType)` —— 遍历 KB 的 `ParserEngineRules`（`[{engine, fileTypes[]}]`），命中即返回该 engine；**空规则 = 全部走 `builtin`**。
- `internal/application/service/knowledge_process.go:3155` `parserEngine := eff.ChunkingConfig.ResolveParserEngine(fileType)` → `resolveDocReader(engine, fileType, ...)`。
- 引擎注册表 `internal/infrastructure/docparser/engine_registry.go`：
  - `builtin`（DocReader，复杂格式）
  - `simple`（Go 原生：md/txt/csv/json/图片/音频）
  - `weknoracloud` / `mineru` / `mineruCloud` / `paddleOCRVLEngine` / `paddleOCRVLCloudEngine`

**结论（用户最关心的问题）**：parser 由 **KB 配置的 `ParserEngineRules`（按文件类型）+ 文件扩展名** 决定，**在服务端选择**。PKW 的 `uploadFile`/`createManualKnowledge` **不传 parser 覆盖**，所以**用户的 KB parser 配置是真正生效的**——只要上传到那个 KB，就遵循该 KB 的规则。

---

## 5. Image / OCR / vision (C7) — 从源码证明

- `internal/types/chunk.go`：`ChunkTypeImageOCR`（`"image_ocr"`）+ `OCRText` 字段存在。
- `internal/types/knowledgebase.go:435` `VLMConfig`（`Enabled` + `ModelID`）+ `IsMultimodalEnabled()`。
- 引擎里有 `paddleOCRVLEngine`（PaddleOCR Vision-Language）、`mineruEngine`（MinerU）。
- **结论**：WeKnora **有** OCR/VLM 能力，但是**可选、按 KB 配置启用**——需要 (a) 选中 OCR/VLM 引擎，(b) 该引擎可用（docreader/凭证），(c) KB `ParserEngineRules` 把图片类型映射到该引擎。**未启用时图片只作为 Attachment 保留，不产生 OCR 文本 knowledge。**

---

## 6. MIME capability matrix (C6)

引擎 FileTypes（源码 `engine_registry.go`）：

| 类型 | PKW 可保存 | WeKnora 可解析 | parser |
|---|---|---|---|
| Markdown (.md) | ✅ | ✅ | simple（Go 原生） |
| TXT | ✅ | ✅ | simple |
| PDF | ✅ | ✅ | builtin（DocReader 必须在线） |
| DOC/DOCX | ✅ | ✅ | builtin |
| XLS/XLSX | ✅ | ✅ | builtin |
| EPUB / MHTML | ✅ | ✅ | builtin |
| CSV / JSON | ✅ | ✅ | simple |
| image png/jpeg/gif/bmp/tiff/webp | ✅ | ✅（可选 OCR/VLM） | simple 存图；OCR 需 VLM 引擎 |
| audio mp3/wav/m4a/flac/ogg | ✅ | ✅ | simple/builtin |
| PPT/PPTX | ✅ | ⚠️ 不在 builtin/simple 显式 FileTypes | 需 MinerU 或未支持（待确认） |
| HTML | ✅ | ⚠️ 不在显式 FileTypes | 待确认 |

**失败语义**：不可解析 → Attachment 仍保存在 PKW（G1：不是错误，是「当前知识库无法解析此文件类型」）。

---

## 7. CURRENT / TARGET / GAP

### CURRENT（已实现）
- Note 插图 → 本地 binary + Markdown reference；Note sync（markdown 文本）；Attachment sync（binary 文件）。
- NoteId↔KnowledgeId 与 AttachmentId↔KnowledgeId 两个独立 durable mapping 都已存在。
- parser 遵循 KB `ParserEngineRules`（未覆盖）。
- WeKnora offline 非阻塞（durable intent + 后台 recovery）。

### TARGET（本轮要补的「产品层」缺口）
- 附件库直接上传 → **Companion Note** 工作流（PART E）。
- Attachment Knowledge 状态的 **UI 可见性**（PART I）。
- `[pkw.knowledge]` observability 日志（PART J）。

### GAP（真正缺的，不是架构错）
1. 直接上传没有「建立伴随 Note」交互（只有 file input）。
2. Attachment Inspector 没展示「知识库状态 / KnowledgeId / 相关笔记」。
3. 无 observability 日志。

### OPTIONS / RECOMMENDATION
- **不改 WeKnora ingestion 语义**（当前已正确：note=manual 文本、attachment=file binary、parser 由 KB 配置决定）。
- 本轮只做：Companion Note 本地工作流 + Knowledge 状态可见性 + 日志 + 文档。这些与 WeKnora 核心无关，可独立推进。

---

## 8. Search 结果回 PKW

- WeKnora hybrid search 返回 chunk，PKW 用 `knowledgeId → 反向映射`（`getMappingByKnowledgeId`）找回 `NoteId`/`AttachmentId`，再展示本地实体。命中 Attachment Knowledge 时能显示 `attachmentId` +（若被引用）相关笔记。

---

## 9. Knowledge identity model (PART F) + Wiki/Graph chain

```
File → Attachment (AttachmentId)  ↕ Attachment KnowledgeId  → parser → summary → Wiki/Graph
Note → Markdown (NoteId)          ↕ Note KnowledgeId        → Wiki/Graph
Wiki pages / Graph nodes          = WeKnora-derived knowledge (NOT Proposition / Memory Relation)
```

- Note Knowledge 与 Attachment Knowledge 是两条**独立 projection**（Note=manual Markdown 文本；Attachment=file binary+parser）。
- Wiki/Graph 由 WeKnora 从 KB 聚合生成，是 **derived knowledge**，不映射回单一 NoteId/AttachmentId（WikiPage/GraphNode 无 knowledge_id 字段）——PKW 只做 title 匹配启发式 deep-link（否则显示「WeKnora 生成内容」），不伪造 NoteId。
- 未来 PLL 是另一层，Wiki node ≠ Proposition、Graph edge ≠ Memory Relation。
