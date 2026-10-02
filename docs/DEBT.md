# PKW 技术负债清单（权威收敛）

> 本文件是 PKW **全部已知技术负债的唯一权威清单**。散落在各文档的负债小节已统一在此，并在来源文档加了「> 收敛于 docs/DEBT.md」指针。
>
> 使用规则：
> - 新增负债 → 写到这里，按类归组，并标注来源文档。
> - 负债存在 **不** 重开 Phase 1（见 `PHASE_1_CLOSURE.md` §8）；只作为 bugfix / Product Sprint / 未来 agent 化的素材。
> - 2026-10-02 三团队审查及实施进度见 `upgrade/PRODUCT_PLAN.md`；已修复项按验证层级登记，生产缺口不因本机通过而关闭。

---

## 产品

| # | 负债 | 来源 |
|---|---|---|
| P1 | Mobile 真机打磨 | `PHASE_1_CLOSURE.md` §7 |
| P2 | Mobile 正文编辑（deferred——Vditor/GopherJS IR 在 iOS Safari IME/selection/keyboard 无充分真机证据，数据安全优先） | `PHASE_1_CLOSURE.md` §4 / §7 |
| P3 | Notes Explorer 多选——checkbox/Ctrl/Shift 多选已交付，**剩余缺口仅 Marquee 矩形框选**（需要 geometry hack） | `PHASE_1_CLOSURE.md` §7 + `SPRINT_RELIABILITY_COHESION_REPORT.md` §Desktop Notes Explorer / §Debt #4 |
| P4 | Source 渲染器打磨 | `PHASE_1_CLOSURE.md` §7 |
| P5 | 大列表虚拟化（large-list virtualization） | `PHASE_1_CLOSURE.md` §7 |
| P6 | 无障碍整体走查：本轮笔记/目录/移动卡片增加主要键盘入口，搜索/状态/工具名称已改善；Task桌面入口、复杂弹层焦点圈定/恢复、辅助技术与真机仍需完整验收 | `upgrade/DESIGN_REVIEW.md`；本轮浏览器走查 |
| P7 | 本轮已区分等待配置/配置不可读/待同步/运行/失败，配置诊断300ms降级；仍需真实WeKnora健康、解析长时间停滞与可执行恢复联验 | `upgrade/PRODUCT_PLAN.md`；本轮隔离预览 |
| P8 | 本轮已修Task matrix/parent引用、恢复可见性、并发顺序及日期清除，30项Tasks回归通过；仍待历史孤儿批量修复、跨记录事件事务性与目标数据验收 | `upgrade/DEVELOPMENT_REVIEW.md` D5 |

## 解析与 AI

| # | 负债 | 来源 |
|---|---|---|
| A1 | 图片 OCR / VLM credential（`IMAGE_PARSER_CAPABILITY_DEBT`——WeKnora 有 OCR/VLM 能力但需按 KB 配置引擎 + 凭证） | `PHASE_1_CLOSURE.md` §7；`archive/A2_RESIDUAL_ACCEPTANCE.md` |
| A2 | Companion summary 的真实 WeKnora 验收仍待目标环境；本机已验证摘要去重及与用户保存交错时的冲突保护，不能由此推断 TXT 的远端摘要已恢复 | `DELIVERY_STATUS.md`；`upgrade/DEVELOPMENT_REVIEW.md`；`archive/A2_LIVE_ACCEPTANCE_RESULT.md` |
| A3 | Wiki / Graph 稳定性 & 下线：WeKnora 仍在生成 wiki/graph，PKW 只消费 graph edges（`getWikiGraph` → `relatedKnowledge`）；彻底下线需在 WeKnora 侧关闭 | `PHASE_1_CLOSURE.md` §7 + `CODEBASE_CLEANUP_REPORT.md` §Deferred |
| A4 | RAG relevance 评估（真实语料到位后） | `PHASE_1_CLOSURE.md` §7 |

## 运维

| # | 负债 | 来源 |
|---|---|---|
| O1 | 通用网络失败已具备 durable intent、退避和重启恢复；仍需补齐解析 terminal failed/长时间停滞的恢复流程与真实服务验收。本轮修复永久错误明细丢失和已恢复历史错误继续计数 | `weknora-sync` 的 failIntent/drain/reconcileNonTerminalAttachments；`upgrade/PRODUCT_PLAN.md` |
| O2 | stalled detector（卡住检测） | `PHASE_1_CLOSURE.md` §7 |
| O3 | retired Processing KB 清理（旧 `retiredKbIds` 未删） | `PHASE_1_CLOSURE.md` §7；`archive/A2_LIVE_ACCEPTANCE_RESULT.md` |
| O4 | stale remote Knowledge 清理 | `PHASE_1_CLOSURE.md` §7 |
| O5 | WeKnora deleting/asynq 停摆：约 50 条 Knowledge 停在 `deleting`，异步删除 worker 未完成 chunk/向量清理——**WeKnora 部署侧问题**，PKW 已正确软删 + 404 + 检索隔离，无法代偿 | `CODEBASE_CLEANUP_REPORT.md` §Deferred + `SPRINT_RELIABILITY_COHESION_REPORT.md` §Debt #3 |
| O6 | WeKnora Neo4j crash-loop（data volume 与 `.env` 密码不一致）——WeKnora 部署问题，复发需在 WeKnora 侧对齐 neo4j 密码 | `WEKNORA_INTEGRATION_CONTINUATION.md` §6 |
| O7 | Lint/tooling：repo 无独立 lint 配置；当前门禁 = `tsc strict` + tests | `WEKNORA_INTEGRATION_CONTINUATION.md` §6 |
| O8 | 性能：`reconcile()` 每 attachment 全量 `open()` 算 sha256；manual CREATE recovery 全 KB list+download；drain 扫 intents O(n) | `WEKNORA_INTEGRATION_CONTINUATION.md` §6 |
| O9 | harness 严格 typecheck 的 `exactOptionalPropertyTypes` 既有错误（~20 处，attachments/events/notes/frontmatter 等）——PKW 自身 tsconfig 全绿，harness `tsconfig.host.json` 下未过 | `SPRINT_RELIABILITY_COHESION_REPORT.md` §Debt #1 |
| O10 | 历史 `multiple exact candidates` 偶发失败未在前轮连续基线中复现；手动 drain 测试已隔离定时器竞争，新增摘要竞态已复现并修复。继续保留目标宿主/长期运行验证缺口 | `DELIVERY_STATUS.md`；`SPRINT_RELIABILITY_COHESION_REPORT.md` §Debt #2 |
| O11 | 浏览器级压测（Part H）未执行；本轮隔离浏览器走查不代表大规模性能或生产浏览器验收 | `SPRINT_RELIABILITY_COHESION_REPORT.md` §Debt #5；`upgrade/PRODUCT_PLAN.md` |
| O12 | 未使用的 domain 类型声明（若干 interface/type）——删除价值低、类型契约边界易误伤，暂不处理 | `CODEBASE_CLEANUP_REPORT.md` §Deferred |
| O13 | Notes / Tasks 写队列只保护单个服务实例；Note 版本/正文哈希比较保护条件保存；外部编辑器/多进程在检查与写入之间的竞争、文件系统与事件/投影的崩溃窗口仍需独立方案与故障注入验收。旧调用方不传条件时保留原兼容行为 | `upgrade/DEVELOPMENT_REVIEW.md` |
| O14 | 完整 CI 依赖 Harness 仓库配置；目标宿主、UI 手工补丁、实际存储位置与生产回退尚未验收 | `DELIVERY_STATUS.md`；`BUILD_AND_DEPLOY.md` |

## 多人协作

用户已确认私人空间 + 团队共享空间。方案与角色矩阵见 `upgrade/COLLABORATION_DESIGN.md`。当前没有完整成员鉴权、空间隔离、权限审计或多人迁移；不得由双窗口冲突保护推断已经支持安全多人使用。新增阶段 C1–C4 按独立权限负例、存储/检索/附件隔离及回退标准验收。

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
| R2 | **罕见词检索噪音**：现有召回与相对下限不足以保证相关性。本轮只修正“正文命中”的误导标签和请求时序；真实质量改善仍需语料评测及 **reranker / LLM 相关性闸门**，不以调阈值替代 | `CODEBASE_MAP.md`「检索已知限制」+ `KNOWLEDGE_RETRIEVAL_DECISION.md` §Ranking limitation |
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
