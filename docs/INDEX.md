# PKW docs 索引（权威目录 / 阅读顺序）

> 这是 `docs/` 的**权威入口**。新上下文先读本页，按下方顺序走，不必翻遍 28 个文件。

## 项目一句话定位

PKW（Personal Knowledge Workspace）是 DSH **宿主插件 monorepo**（`packages/pkw/*`，每个包 = `@deepseek-ai/dsh-pkw-<name>`）。它以 **Markdown Note + Attachment binary 为 canonical**，把 **WeKnora** 作为解析 / 索引 / 检索 / 派生知识引擎，提供工作区 / 笔记 / 附件 / 任务 / 回收站 / 统一 RAG 检索的个人知识工作空间。**Phase 1 已 CLOSED**，权威闭包见 `PHASE_1_CLOSURE.md`。

## 推荐阅读顺序

1. **现状锚点** → `PHASE_1_CLOSURE.md`（冻结决策 + 债务）→ `CODEBASE_MAP.md`（代码现状）
2. **设计根** → `HARNESS_ADAPTER_REPORT.md` → `PHASE1_DESIGN.md` → `PHASE2_DESIGN.md`
3. **知识模型** → `KNOWLEDGE_RETRIEVAL_DECISION.md` → `KNOWLEDGE_REPRESENTATION.md` → `ATTACHMENT_REPRESENTATION_DECISION.md` → `KNOWLEDGE_IDENTITY_POLICY.md` → `KNOWLEDGE_INGESTION_POLICY.md` → `NOTE_SCOPED_PROCESSING.md` → `ATTACHMENT_KNOWLEDGE_PIPELINE.md`
4. **生命周期** → `NOTE_BUSINESS_LIFECYCLE.md` → `TRASH_MANAGEMENT.md`
5. **前端 UI** → `UI_SYSTEM.md` → `MARKDOWN_RENDERER_DECISION.md` → `EDITOR_CAPABILITY_MATRIX.md` → `VIEW_PERFORMANCE_REPORT.md`
6. **WeKnora 集成** → `WEKNORA_INTEGRATION_CONTINUATION.md`
7. **负债** → `DEBT.md`（全部已知负债的唯一权威清单）

## Canonical 文档（按主题分组）

### 定位与设计
| 文档 | 内容 |
|---|---|
| [`HARNESS_ADAPTER_REPORT.md`](./HARNESS_ADAPTER_REPORT.md) | Phase 0：PKW 设计词汇 → DeepSeek Harness / Cordis 实际扩展系统（三平面：Bundle/Profile/Preset）的映射结论，是后续设计的唯一事实源。 |
| [`PHASE1_DESIGN.md`](./PHASE1_DESIGN.md) | Phase 1 设计：领域基础 + workspace-core + 持久化事件（Host 面）。 |
| [`PHASE2_DESIGN.md`](./PHASE2_DESIGN.md) | Phase 2 设计：Markdown Notes + Attachments（Host 面，含 harness seam 核验）。 |

### Phase 闭包与现状
| 文档 | 内容 |
|---|---|
| [`PHASE_1_CLOSURE.md`](./PHASE_1_CLOSURE.md) | **权威闭包**：冻结架构决策、否决方向、已交付能力、移动端策略、检索终态、Phase 1 债务、reopen 规则。 |
| [`CODEBASE_MAP.md`](./CODEBASE_MAP.md) | **当前 codebase map**：包结构、运行时接线、检索核心、已知检索限制。 |
| [`CODEBASE_CLEANUP_REPORT.md`](./CODEBASE_CLEANUP_REPORT.md) | Post-closure 维护：删了什么（DOCX / Wiki/Graph UI / 死模块）、保留什么（getWikiGraph 边映射）、Deferred 负债。 |
| [`SPRINT_RELIABILITY_COHESION_REPORT.md`](./SPRINT_RELIABILITY_COHESION_REPORT.md) | Post-closure sprint 报告：可靠性修复、WeKnora 生命周期收敛、桌面 Explorer、检索 relevance 修复、Debt。 |

### 知识模型与检索
| 文档 | 内容 |
|---|---|
| [`KNOWLEDGE_RETRIEVAL_DECISION.md`](./KNOWLEDGE_RETRIEVAL_DECISION.md) | A1 vs A2 检索架构决策（A2 federated 胜出）+ ranking 限制。 |
| [`KNOWLEDGE_REPRESENTATION.md`](./KNOWLEDGE_REPRESENTATION.md) | 三身份（Business Knowledge / Source Asset / Processing Artifact）+ OPTION A「PKW Aggregation Only」决策。 |
| [`ATTACHMENT_REPRESENTATION_DECISION.md`](./ATTACHMENT_REPRESENTATION_DECISION.md) | 附件表示冻结决策（三次实验）+ 各 surface projection 表。 |
| [`KNOWLEDGE_IDENTITY_POLICY.md`](./KNOWLEDGE_IDENTITY_POLICY.md) | 远端唯一性策略：一个上传只产出一个 WeKnora Knowledge（OPTION B attachment-backed）。 |
| [`KNOWLEDGE_INGESTION_POLICY.md`](./KNOWLEDGE_INGESTION_POLICY.md) | Ownership 矩阵：`standalone` / `note-scoped` / `local-only` 三模式 + 18 场景。 |
| [`NOTE_SCOPED_PROCESSING.md`](./NOTE_SCOPED_PROCESSING.md) | note-scoped 附件的 Processing KB 解析管线（不污染主 KB）。 |
| [`ATTACHMENT_KNOWLEDGE_PIPELINE.md`](./ATTACHMENT_KNOWLEDGE_PIPELINE.md) | 附件 → Note → WeKnora 真实数据路径审计（parser 选择、MIME 矩阵、Companion Note）。 |
| [`KNOWLEDGE_OPTION_A_MIGRATION.md`](./KNOWLEDGE_OPTION_A_MIGRATION.md) | OPTION A 迁移计划（dual-projection → 单 Business Knowledge，未执行）。 |

### 存储与生命周期
| 文档 | 内容 |
|---|---|
| [`NOTE_BUSINESS_LIFECYCLE.md`](./NOTE_BUSINESS_LIFECYCLE.md) | Note/Attachment 业务编排：身份不变量 + Mutation 矩阵 + Companion Note 生命周期。 |
| [`TRASH_MANAGEMENT.md`](./TRASH_MANAGEMENT.md) | 回收站能力与生命周期（单/批/清空，`trashEntryId` 身份）。 |

### 前端 UI
| 文档 | 内容 |
|---|---|
| [`UI_SYSTEM.md`](./UI_SYSTEM.md) | UI 设计系统 v1：主题三态、语义 token、布局、组件、编辑器暗色。 |
| [`MARKDOWN_RENDERER_DECISION.md`](./MARKDOWN_RENDERER_DECISION.md) | Markdown 渲染决策：Lute 为主 + 极简 wiki-link 扩展层。 |
| [`EDITOR_CAPABILITY_MATRIX.md`](./EDITOR_CAPABILITY_MATRIX.md) | 编辑器能力矩阵（表格 / 脚注 / callout / wiki-link 的 CORE/WIRED/READING 状态）。 |
| [`VIEW_PERFORMANCE_REPORT.md`](./VIEW_PERFORMANCE_REPORT.md) | 视图性能：cache-first、single-flight、stale 导航守卫、冷/热切换。 |

### WeKnora 集成
| 文档 | 内容 |
|---|---|
| [`WEKNORA_INTEGRATION_CONTINUATION.md`](./WEKNORA_INTEGRATION_CONTINUATION.md) | **长期状态记忆**：WeKnora 集成当前状态、已实现能力、配置模型、不变量、剩余负债。新上下文只读它 + 代码即可续接。 |

## 负债

- [`DEBT.md`](./DEBT.md) —— **全部已知技术负债的权威清单**（按 产品 / 解析与AI / 运维 / 迁移 / 检索 分组，每条标注来源）。

## 已归档（`docs/archive/`）

这些是「某一次实验 / 验收 / 决策门」的**当时结论，现在只作历史证据**，不参与当前决策。归档是可逆的，正文未删除。

| 文档 | 为什么归档 |
|---|---|
| `archive/A2_LIVE_ACCEPTANCE_RESULT.md` | A2 TXT 路径的一次性 live 验收结果，已收敛进 `PHASE_1_CLOSURE.md` §5（A2 Retrieval Core = CLOSED）。 |
| `archive/A2_RESIDUAL_ACCEPTANCE.md` | A2 残留验收（multi-owner / isolated / dedupe）的一次性结果，已收敛进闭包。 |
| `archive/DOCX_TRANSPORT_ACCEPTANCE.md` | DOCX transport live 实验（失败）——DOCX primary transport 已被 `PHASE_1_CLOSURE.md` §2 否决。 |
| `archive/WEKNORA_RESOURCE_MAPPING_POC.md` | `resource://` 映射 POC（REJECTED）——已被闭包 §2 否决（当前 API surface 无外部注册/授权接口）。 |
| `archive/WEKNORA_WIKI_GRAPH_PORT.md` | Wiki/Graph 移植的 source audit——其可视化 UI 已删（见 `CODEBASE_CLEANUP_REPORT.md`），仅保留 `getWikiGraph` 边映射供 Business Viewer 的 `relatedKnowledge`。 |

## 已废弃（保留正文，仅头部标注）

| 文档 | 替代 |
|---|---|
| [`WORD_NOTE_MIGRATION.md`](./WORD_NOTE_MIGRATION.md) | ⚠️ Superseded by `PHASE_1_CLOSURE.md` §2（DOCX canonical / primary transport 均被否决）。 |

## 指向仓库其它位置

- 根 `README.md`：仓库级定位 / 构建 / 使用（由另一子代理维护）。
- `CODEBASE_MAP.md`：想直接看代码结构，从这里进。
