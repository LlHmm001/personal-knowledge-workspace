# PKW 技术负债清单（权威收敛）

> 本文件是 PKW **全部已知技术负债的唯一权威清单**。散落在各文档的负债小节已统一在此，并在来源文档加了「> 收敛于 docs/DEBT.md」指针。
>
> 使用规则：
> - 新增负债 → 写到这里，按类归组，并标注来源文档。
> - 负债存在 **不** 重开 Phase 1（见 `PHASE_1_CLOSURE.md` §8）；只作为 bugfix / Product Sprint / 未来 agent 化的素材。
> - 另一个子代理正在并行迁移代码，可能新增负债；本条清单以**当前已收敛的**为准，新负债稍后追加。

---

## 产品

| # | 负债 | 来源 |
|---|---|---|
| P1 | Mobile 真机打磨 | `PHASE_1_CLOSURE.md` §7 |
| P2 | Mobile 正文编辑（deferred——Vditor/GopherJS IR 在 iOS Safari IME/selection/keyboard 无充分真机证据，数据安全优先） | `PHASE_1_CLOSURE.md` §4 / §7 |
| P3 | Notes Explorer 多选——checkbox/Ctrl/Shift 多选已交付，**剩余缺口仅 Marquee 矩形框选**（需要 geometry hack） | `PHASE_1_CLOSURE.md` §7 + `SPRINT_RELIABILITY_COHESION_REPORT.md` §Desktop Notes Explorer / §Debt #4 |
| P4 | Source 渲染器打磨 | `PHASE_1_CLOSURE.md` §7 |
| P5 | 大列表虚拟化（large-list virtualization） | `PHASE_1_CLOSURE.md` §7 |

## 解析与 AI

| # | 负债 | 来源 |
|---|---|---|
| A1 | 图片 OCR / VLM credential（`IMAGE_PARSER_CAPABILITY_DEBT`——WeKnora 有 OCR/VLM 能力但需按 KB 配置引擎 + 凭证） | `PHASE_1_CLOSURE.md` §7；`archive/A2_RESIDUAL_ACCEPTANCE.md` |
| A2 | Companion summary 落地（materialize）——TXT 路径曾 BLOCKED BY SUMMARY | `PHASE_1_CLOSURE.md` §7；`archive/A2_LIVE_ACCEPTANCE_RESULT.md` |
| A3 | Wiki / Graph 稳定性 & 下线：WeKnora 仍在生成 wiki/graph，PKW 只消费 graph edges（`getWikiGraph` → `relatedKnowledge`）；彻底下线需在 WeKnora 侧关闭 | `PHASE_1_CLOSURE.md` §7 + `CODEBASE_CLEANUP_REPORT.md` §Deferred |
| A4 | RAG relevance 评估（真实语料到位后） | `PHASE_1_CLOSURE.md` §7 |

## 运维

| # | 负债 | 来源 |
|---|---|---|
| O1 | 失败自动重试（failed automatic retry） | `PHASE_1_CLOSURE.md` §7 |
| O2 | stalled detector（卡住检测） | `PHASE_1_CLOSURE.md` §7 |
| O3 | retired Processing KB 清理（旧 `retiredKbIds` 未删） | `PHASE_1_CLOSURE.md` §7；`archive/A2_LIVE_ACCEPTANCE_RESULT.md` |
| O4 | stale remote Knowledge 清理 | `PHASE_1_CLOSURE.md` §7 |
| O5 | WeKnora deleting/asynq 停摆：约 50 条 Knowledge 停在 `deleting`，异步删除 worker 未完成 chunk/向量清理——**WeKnora 部署侧问题**，PKW 已正确软删 + 404 + 检索隔离，无法代偿 | `CODEBASE_CLEANUP_REPORT.md` §Deferred + `SPRINT_RELIABILITY_COHESION_REPORT.md` §Debt #3 |
| O6 | WeKnora Neo4j crash-loop（data volume 与 `.env` 密码不一致）——WeKnora 部署问题，复发需在 WeKnora 侧对齐 neo4j 密码 | `WEKNORA_INTEGRATION_CONTINUATION.md` §6 |
| O7 | Lint/tooling：repo 无独立 lint 配置；当前门禁 = `tsc strict` + tests | `WEKNORA_INTEGRATION_CONTINUATION.md` §6 |
| O8 | 性能：`reconcile()` 每 attachment 全量 `open()` 算 sha256；manual CREATE recovery 全 KB list+download；drain 扫 intents O(n) | `WEKNORA_INTEGRATION_CONTINUATION.md` §6 |
| O9 | harness 严格 typecheck 的 `exactOptionalPropertyTypes` 既有错误（~20 处，attachments/events/notes/frontmatter 等）——PKW 自身 tsconfig 全绿，harness `tsconfig.host.json` 下未过 | `SPRINT_RELIABILITY_COHESION_REPORT.md` §Debt #1 |
| O10 | flaky 测试：`multiple exact candidates → deterministic canonical` 一次非确定性失败（疑似 fake adapter 顺序相关），未归因 | `SPRINT_RELIABILITY_COHESION_REPORT.md` §Debt #2 |
| O11 | 浏览器级压测（Part H）未执行；真实数字需部署后浏览器 smoke | `SPRINT_RELIABILITY_COHESION_REPORT.md` §Debt #5 |
| O12 | 未使用的 domain 类型声明（若干 interface/type）——删除价值低、类型契约边界易误伤，暂不处理 | `CODEBASE_CLEANUP_REPORT.md` §Deferred |

## 迁移

| # | 负债 | 来源 |
|---|---|---|
| M1 | historical migration（历史数据迁移，整体未做） | `PHASE_1_CLOSURE.md` §7（MIGRATION DEBT） |
| M2 | OPTION A 迁移（dual-projection → 单 Business Knowledge）——迁移计划已备（`KNOWLEDGE_OPTION_A_MIGRATION.md`），**未对生产执行**，需先跑 dedicated test KB 垂直切片 | `KNOWLEDGE_OPTION_A_MIGRATION.md` |
| M3 | 历史 note-scoped 重复的 reconcile：legacy attachments 无 `knowledgeMode`，不自动重分类（禁 title-based 删除） | `KNOWLEDGE_INGESTION_POLICY.md` §Deferred |

## 检索

| # | 负债 | 来源 |
|---|---|---|
| R1 | RAG relevance tuning deferred until real corpus（真实语料到位前不动） | `PHASE_1_CLOSURE.md` §5 |
| R2 | **罕见词检索噪音**：WeKnora hybrid-search 无服务端阈值（必回 `match_count`）、PKW 相对下限 `top*0.25` 近乎 no-op、「正文命中」标签误导——正确修法需 **reranker / LLM（agent 化）相关性闸门**，非调阈值；本轮不修（避免「搜不到」回归） | `CODEBASE_MAP.md`「检索已知限制」+ `KNOWLEDGE_RETRIEVAL_DECISION.md` §Ranking limitation |
| R3 | Main-KB 与 Processing-KB hybrid-search 分数不可直接比较：首版按 KB 独立 top-K → 业务级合并，**无精确统一排序** | `KNOWLEDGE_RETRIEVAL_DECISION.md` §Ranking limitation |

---

## 附：来源文档 → 本节映射

- `PHASE_1_CLOSURE.md` §7 → 产品 P1–P5 / 解析 A1–A4 / 运维 O1–O4 / 迁移 M1（+ §4/§5 的 P2、R1）
- `SPRINT_RELIABILITY_COHESION_REPORT.md` §Debt → O5/O9/O10/O11 + P3
- `CODEBASE_MAP.md`「检索已知限制」→ R2
- `CODEBASE_CLEANUP_REPORT.md` §Deferred → A3/O5/O12
- `KNOWLEDGE_RETRIEVAL_DECISION.md` §Ranking limitation → R2/R3
- `WEKNORA_INTEGRATION_CONTINUATION.md` §6 → O6/O7/O8
- `KNOWLEDGE_INGESTION_POLICY.md` §Deferred → M3
- `KNOWLEDGE_OPTION_A_MIGRATION.md` → M2
