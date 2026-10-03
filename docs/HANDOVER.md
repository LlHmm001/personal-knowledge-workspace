# PKW 交接文档 — 给下一位改造者（Codex）

> **后续工程进展**：构建、部署与测试更新见
> [DELIVERY_STATUS.md](DELIVERY_STATUS.md) 和 [BUILD_AND_DEPLOY.md](BUILD_AND_DEPLOY.md)。
> 2026-10-02 三团队专业升级范围与验收见 [upgrade/PRODUCT_PLAN.md](upgrade/PRODUCT_PLAN.md)。
> 下文的“无 build 脚本 / 基线不绿”保留为接手时快照；当前完成状态以上述分层证据为准。

> **这份文档是给"接手并升级这个项目"的 agent/工程师看的。** 它回答四件事：
> ① 这个项目到底是什么；② 现在真实跑的是什么；③ 哪些是不能碰的边界；④ 升级要从哪里下手、按什么顺序、怎么验收。
>
> **读法**：先读 §1、§2、§3 建立全局认知 → 读 §6、§7 搞清"源码到线上"的路 → 读 §8、§9 领任务。
> 需要更细的东西时按 §11 的索引查。

| 项目 | 值 |
| --- | --- |
| 名称 | Personal Knowledge Workspace（PKW） |
| 形态 | DSH（DeepSeek Harness）宿主插件扩展，pnpm workspace monorepo |
| 本仓库位置 | `/LlHmm9527/Personal Knowledge Workspace`（GitHub 主仓，两条环境同步的中枢） |
| 生产部署位置 | DSH profile `web` 的 node_modules（见 §6） |
| 当前分支 | `master` |
| 阶段 | **Phase 1 CLOSED / ACCEPTED**；升级 = 在此之上做 Phase 2 或可靠性工程 |
| 代码规模 | 99 个受控文件，约 1.4 MB（不含 node_modules） |
| 包数 | 10 个 `@deepseek-ai/dsh-pkw-*` |
| 测试 | 20 个 spec 文件，255+ 用例；**基线不绿，见 §10.1** |
| 许可证 | Apache-2.0 |

---

## 1. 一句话说清这个项目

PKW 是**跑在 DSH 之上的个人知识工作区**：以 **Markdown Note 为唯一真相源（canonical）**，
把「笔记 / 文件夹 / 任务 / 附件」组织成一套**本地优先（local-first）**的知识管理能力，
再通过 **WeKnora** 做解析、索引、检索和派生知识。

它不是一个独立应用，而是**挂进 DSH 进程的插件 bundle**：DSH 提供 storage / fs / workspace /
webserver / credentials 这些"地基"，PKW 只负责"知识"这一层的领域逻辑和 UI。

**用户看到的产品面**：Workspace / Notes / Folders / 桌面端编辑器 / 移动端只读优先 /
Knowledge Home（知识主页）/ 统一 RAG 检索 / Sources（附件）/ Tasks（艾森豪威尔 Q1–Q4）/ Trash（回收站）。
浏览器入口是 `/pkw`。

---

## 2. 世界模型：三层 Knowledge（整个项目的心脏）

这是 PKW 最容易讲错、也最不能改错的部分。**一个 Note 加上它的附件，在系统里对应三种 Knowledge**：

```
        ┌──────────────────────────────────────────────────────────┐
        │  Main Knowledge（主知识）                                 │
        │  = Note 的正文/上下文投影                                  │
        │  一个 Note → 最多一个 Main Knowledge                       │
        └──────────────────────────────────────────────────────────┘
                              +
        ┌──────────────────────────────────────────────────────────┐
        │  Processing Knowledge（处理知识）                          │
        │  = 附件二进制经 OCR/parser 解析出的 chunks/summary         │
        │  住在独立的 Processing KB 里，不对外暴露身份                │
        └──────────────────────────────────────────────────────────┘
                              ↓  聚合
        ┌──────────────────────────────────────────────────────────┐
        │  Business Knowledge（业务知识）= 用户真正看到的对象         │
        │  = Note + 它的 Sources（附件）聚合而成                     │
        │  Processing 命中 → AttachmentId → NoteId → Business        │
        └──────────────────────────────────────────────────────────┘
```

**A2 Retrieval（检索核心）** 就是这个聚合的落地：

```
searchWithTrace(query):
  Main KB hybridSearch  ┐
                        ├→ 按 businessKey 聚合去重 → active canonical 过滤
  Processing KB 检索    ┘   → relevance floor → 结果 + trace
```

**关键语义（改代码前必须记住）**：

- WeKnora 只是**解析/索引/检索/摘要引擎**，是可替换的实现细节；它给的 remote KnowledgeId
  **永远不是用户身份**，不能泄漏到 UI。
- **本地保存/读取绝不依赖 WeKnora 可用性**。WeKnora 挂了，笔记照样能读能写，只是同步进入 pending。
- Processing KnowledgeId **不暴露**给用户；用户结果只带 `matchReason` + `matchedAttachmentId` 这种业务溯源。

---

## 3. 代码地图：10 个包分别在干什么

pnpm workspace，全部在 `packages/pkw/*`，包名 `@deepseek-ai/dsh-pkw-<name>`。

| 包 | 注册的 Cordis 服务 | 职责 | 关键入口 |
| --- | --- | --- | --- |
| `domain` | —（runtime-free） | 领域基础：branded id / OperationContext / DomainEvent、zod domain spec、Markdown 纯函数（footnote / table / editor-commands / lute-pipeline / note-projection / companion-summary / direct-upload） | `src/index.ts` |
| `events` | `ctx.pkwEvents` | durable 事件库：OperationCommit 原子追加 + 幂等 + post-commit signal | `src/index.ts` |
| `workspace` | `ctx.pkwWorkspace` | 工作区布局 + `ctx.fs` 路径安全 + OperationContext 工厂 | `src/index.ts` |
| `notes` | `ctx.pkwNotes` | **Markdown canonical**、NoteIndex 可重建投影、folder CRUD、trash/restore、reconcile | `src/index.ts` |
| `tasks` | `ctx.pkwTasks` | TaskMatrix + Task store；艾森豪威尔象限是**派生**的，不落库 | `src/index.ts` |
| `attachments` | `ctx.pkwAttachments` | **binary canonical** + catalog 投影 | `src/index.ts` |
| `weknora` | `ctx.pkwWeKnora` | WeKnora 0.7.1 REST adapter（manual / file / knowledge / search / KB / chunks / getWikiGraph） | `src/index.ts` |
| `weknora-sync` | `ctx.pkwWeKnoraSync` | local-first 同步 worker（durable intent/mapping、A2 Processing KB、`searchWithTrace` 检索核心） | `src/index.ts` |
| `web` | `ctx.pkwWeb` | Host HTTP 桥 + 浏览器 UI：`/pkw` 页面、`/pkw/api` RPC、`/pkw/attachment` 字节路由 | `src/index.ts` + `src/ui.ts` |
| `base` | —（bundle patch） | Host-plane 组合：`cordis.patch.yml` 插入 storage / workspace / pkw 行 | `cordis.patch.yml` |

### 运行时接线（"谁在真正跑"）

- **服务注册链**：`pkw-web` 是**唯一入口**。它自己的 `Service.init` 用 `ctx.plugin()` 把其余
  7 个 PKW 服务挂成子插件，所以不会重复注册。
- **显式服务名**：`pkwEvents` / `pkwWorkspace` / `pkwNotes` / `pkwTasks` / `pkwAttachments` /
  `pkwWeKnora` / `pkwWeKnoraSync` / `pkwWeb`。这些是**对外契约**，改名等于破坏兼容。
- **RPC 是唯一 UI 入口**：`web/src/index.ts` 的 `call(method, args)` switch（约 69 个 method）。
  UI 只走 `POST /pkw/api`，**从不直接碰 SQLite / fs / WeKnora**。
- **事件**：`pkw/event.committed`（emit，post-commit 实时信号）。同步 worker 监听它来标 dirty。
  注意：它是**信号，不是审计日志**。

### 数据落点

- 工作区目录：`workspacePath` 下有 `notes/`（Markdown canonical）与 `attachments/`（二进制 canonical），
  另有 `archive/`（trash）。当前部署实例：`/root/.dsh/pkw/workspace/`。
  **这是用户最核心的资产**，升级时它是迁移对象，不是可以重建的缓存。
- 结构化状态（NoteIndex / Task store / event log / sync mapping）走 harness storage seam，
  按 `workspaceId` 分区；`packages/pkw/base/cordis.patch.yml` 里规划的落点是
  `dshHomePath('pkw','pkw.sqlite')`，**不是**工作区目录里的 `.system/workspace.sqlite`。

> ⚠️ **待核实（交给 Codex）**：本次交接在文件系统里**没能找到**任何 `pkw*.sqlite` 或
> 等价的 JSON domain 文件。这意味着要么该实例的结构化状态落在别处、要么中途改过
> backend 配置。**升级动 schema 之前，必须先确认"结构化状态现在到底存在哪"**，
> 否则无法判断迁移影响面。查找线索：`docs/portability/CONFIGURATION_MIGRATION.md`、
> harness 的 `dsh-base` bundle row 配置。

---

## 4. 冻结的架构决策（Frozen — 升级时不得重新设计）

以下在 Phase 1 收尾时已 **ACCEPTED 并冻结**。除非 §5 的 reopen 条件成立，否则**不要重新设计**，
只在其上扩展。

| 决策 | 状态 |
| --- | --- |
| Markdown Note = canonical | **ACCEPTED** |
| Attachment binary = canonical | **ACCEPTED** |
| Folder = 真实目录 / `relativePath` 派生（**没有 Folder entity**） | **ACCEPTED** |
| `NoteId` = stable identity | **ACCEPTED** |
| `AttachmentId` = stable identity | **ACCEPTED** |
| Task Store = canonical Task source | **ACCEPTED** |
| A2 Retrieval（Main + Processing → Business） | **ACCEPTED** |

### 身份不变量（永不回归）

- `NoteId` 稳定；**`relativePath` 可变，永远不是身份**。
- `AttachmentId`（`att_<12hex>`）稳定；**文件名只是展示元数据，永远不是身份**。
- **`path` 是位置，不是身份。**

### 已拒绝的方向（不要自动重开）

| 方向 | 决策 |
| --- | --- |
| DOCX 作为 canonical | **REJECTED** |
| DOCX 作为主传输通道 | **REJECTED** |
| 用文件系统绝对路径作为资产身份 | **REJECTED** |
| PKW → WeKnora `resource://` 集成 | 当前 API 面下 **REJECTED** |
| A1 把附件完整物化进 Main Knowledge | **REJECTED** |

> 注意一个**后置修正**：原决策里"DOCX utility/export RETAINED"已被后续 cleanup 推翻——
> 所有 DOCX 代码（`docx-note.ts` + `docx`/`jszip` 依赖）连同 Wiki/Graph 可视化 UI 都已删除。
> 详见 `docs/CODEBASE_CLEANUP_REPORT.md`。

### 冻结时的移动端策略

- 桌面端 = 完整创作/编辑体验；移动端 = **只读优先**（阅读/导航/检索/来源/任务/管理）。
- **移动端正文编辑 = DEFERRED**。原因：Vditor（GopherJS IR）在 iOS Safari 的 IME/选区/键盘
  行为缺乏足够的真机证据。**数据安全优先于功能完整。**
  只有编辑器底层条件真正变化时才重新评估。

---

## 5. 什么情况下可以重开 Foundation

只有这几种情况允许动 §4 的冻结决策：

- canonical 数据损坏
- 身份（identity）损坏
- 数据丢失
- 权限 / 安全被破坏
- A2 核心不变量被破坏
- Task Store 不变量被破坏

其余一切：普通 bug → **bugfix**；体验问题 → **Product Sprint**。
**"债务存在"不构成重开 Phase 1 的理由。**

> **Phase 2 尚未启动。** 冻结文件明确写了 "Do NOT start Phase 2"：
> Task↔Knowledge、PLL、Memory、Agent workflow、Migration、新 AI 能力都不在当时的范围内。
> **但本次交接的目的正是要启动下一阶段** —— 所以 §9 给出的升级路线是经过判断的候选清单，
> 而不是自动继承 Phase 1 的禁令。启动前请与项目所有者确认范围。

---

## 6. 部署现实（⚠️ 最重要的一节：源码 ≠ 线上）

**这是本次交接发现的最大问题，也是升级前必须先解决的前提。**

### 6.1 线上跑的到底是什么

DSH profile `web` 加载的 PKW **不是本仓库的源码**，而是：

```
/root/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-pkw-*/lib/*.js
```

这些是**编译产物**。事实清单：

| 事实 | 证据 |
| --- | --- |
| 本仓库**没有任何 build 脚本** | `package.json` 只有 `test` / `typecheck`；无 esbuild/rollup/tsup 配置 |
| 本仓库**没有任何部署脚本** | 无 Makefile / justfile / deploy 脚本 |
| 线上产物来自本地 npm registry | `/root/.dsh/profiles/web/.npmrc` → `@deepseek-ai:registry=http://localhost:4873/` |
| registry 里只有一个版本 | `@deepseek-ai/dsh-pkw-web@0.1.0`，发布于 **2026-08-22T09:11Z** |
| 线上 `lib/` 已被**手工改动** | `dsh-pkw-web/lib/ui.js` mtime **2026-08-25**，另有 `ui.js.bak-20260831-072433` |
| 线上产物**不一致** | `dsh-pkw-attachments/lib` mtime **2026-09-06**，其余 8 个包停在 **2026-08-22** |
| 旧的软链已失效 | `/opt/deepseek-harness/packages/pkw` **不存在**（历史上曾是软链） |

**结论：从"仓库源码"到"线上生效"这条路目前是断的、手工的、不可复现的。**
`lib/ui.js` 里的内容与仓库 `src/ui.ts` **已经分叉**——线上看到的部分行为来自手改产物，
而不是任何一次可追溯的构建。

### 6.2 这意味着什么（给升级者的直接后果）

1. **你改了仓库，线上不会有任何变化。** 必须先建立构建+发布管线。
2. **你看到的"线上行为"未必对应仓库代码。** 排查 bug 时要先确认排查对象是哪个产物。
3. **任何升级都必须先补上 §7 的工程化缺口**，否则交付无法验收。

### 6.3 建议的构建/发布管线（待实现，Codex 的第一个工程任务）

目标：`src/*.ts` → `lib/*.js` → 本地 registry → profile install，全链路可复现。

```
① 每个包加 build 脚本（推荐 tsc emit 或 tsup，输出到 lib/）
② 根 package.json 加 "build": "pnpm -r build"
③ 版本提升 + pnpm publish 到本地 registry（http://localhost:4873）
④ profile 侧 pnpm install 更新 node_modules
⑤ 重启 DSH web 进程，验证 /pkw
```

同时把 §7 里那些"机器绑定"换成可移植形式（`config.example.yaml` 已经给了模板）。

---

## 7. 构建系统的机器绑定（可移植化缺口）

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `tsconfig.json` / `tsconfig.base.json` | harness 依赖解析到 `/opt/deepseek-harness/...` 绝对路径 | 依赖一个部署期约定的软链 |
| profile `package.json` | `"@deepseek-ai/dsh-extension-pkw": "file:/LlHmm9527/PluginMarket/..."` | 绝对路径 `file:` 依赖 |
| profile bundle `cordis.patch.yml` | `kbId: '<一份真实部署的 KB id>'`、`weknoraBaseUrl: 'http://127.0.0.1:18088/api/v1'` | **机器绑定值硬编码在部署物里** |
| harness 仓库 | 历史上 `packages/pkw` 软链到本仓库 | 已失效 |

**已有的资产**（在 `docs/portability/` 与仓库根）：

- `config.example.yaml` — 配置模板，说明哪些值必须外部注入。
- `docs/portability/DEPENDENCY_STRATEGY.md` — 依赖可移植化策略与降级方案。
- `docs/portability/CONFIGURATION_MIGRATION.md` — 旧硬编码值 → 环境变量的迁移表。
- `docs/portability/PATH_AUDIT.md` — 构建系统路径耦合的扫描结果与修复策略。

**关于 `tsconfig` 的 `/opt/deepseek-harness` 绝对路径**：`tsconfig.json` 里有一条明确注释说明
这是**刻意的选择**——部署把 `/opt/deepseek-harness` 保持为指向当前 release 的软链，
所以它比版本化的 `/opt/dsh-releases/v-*` 更稳定。历史上 `portable` 分支曾改成兄弟目录
`../deepseek-harness`，但**该布局在部署环境并不存在**（且 `tsc` 会直接失败）。

> **给 Codex 的建议**：不要盲目"去绝对路径"。正确做法是把这个 seam 变成**显式配置**
> （环境变量 `DSH_HARNESS_ROOT`，默认 `/opt/deepseek-harness`），这样本机开发与部署都能用，
> 而不是二选一。

---

## 8. 当前质量状态（诚实基线）

### 8.1 测试基线：不绿 ❌

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | ✅ **exit 0**（干净） |
| `pnpm test` | ❌ **失败**，且**失败数量在 1~6 之间浮动** |

已确认的现象：

1. **`packages/pkw/weknora-sync/tests/sync.spec.ts` 有并发竞态**。
   同一个 spec 单独跑：两次里一次 46/46 全绿、一次 1 个失败（`materializes the Attachment
   Knowledge summary...`）。放进全量套件跑（并发更高）会变成 3~4 个失败。
   典型失败用例：`third-state drift`、`marks never-synced entities dirty and converges`、
   `materializes the Attachment Knowledge summary into the Companion Note`。
   **根因方向**：后台 sync worker 按 `pollMs` 轮询，测试用 `vi.waitFor` 等它收敛；
   并发下 worker 的时序被打乱，等待窗口不够。**这是测试的稳定性问题，需要逐个案例
   确认是测试该等更久，还是 worker 存在真实竞态。**
2. **已修一个**：`multiple exact candidates → deterministic canonical` 用例原本也会失败，
   原因是后台 worker 抢在 `recoverNote` 之前建好了 mapping，使 recovery 走了
   "已知 KnowledgeId 快路径"而不是"候选枚举路径"——测试想覆盖的恰恰是后者。
   已通过在测试内隔离 worker 轮询（`boot({ pollMs: 3_600_000 })`）修正。

> **不要为了让 CI 变绿而删测试或放宽断言。** 先把 `sync.spec.ts` 的不稳定性真正定位清楚，
> 再决定是修测试还是修 worker。

### 8.2 其他已知问题

- **`packages/pkw/notes/tests/migration.spec.ts` 已被 `describe.skip` 停用（未删除）**：
  这份测试来自旧的 `portable` 分支，依赖**当前 harness 已不存在**的 storage API——
  `defineDomain({ migrations })` 不是当前 spec 的一部分（`storage-json` / `storage-sqlite`
  对版本不匹配的 medium 是**直接拒绝**），且 JSON backend 的 `openUnit` 形状已变，
  **3 个用例原本全部报错**。
  但它覆盖的**主题是重要的**：PKW 的 domain spec 停在 `version: 3` 且**没有迁移路径**，
  由旧版 PKW 写出的 medium 在新版本上会被拒绝打开。
  **建议：按当前 harness storage API 重写后重新启用，而不是删掉。**
  （文件头注释里写了同样的说明和定位线索。）
- **检索相关性（RAG relevance）**：搜罕见词时第 1 条正确，后续若干条无关。
  根因链已查清（见 `docs/CODEBASE_MAP.md` §"检索已知限制"）：WeKnora `hybrid-search`
  **无服务端阈值**，真假分数区间重叠，任何静态阈值都切不干净；
  当前 PKW 的相对下限 `top * 0.25` 实际是 no-op。
  **正确修法是需要真正的 reranker / LLM 相关性闸门，而不是调阈值。**
  这是**留给 agent 化的**，不是配置问题。

---

## 9. 建议的升级路线（候选，按依赖排序）

> 这些是候选清单，不是自动授权。启动前与项目所有者确认范围与优先级。

### P0 — 让"升级"这件事本身成立（不解决就没有可验收的交付）

1. **建立构建管线**：`src/*.ts` → `lib/*.js`，根 `pnpm build`，全仓可复现。见 §6.3。
2. **建立发布/部署脚本**：build → publish 到本地 registry → profile install → 重启验证 `/pkw`。
   把这条流程写进仓库，替换现在的手工粘贴。
3. **止血手工补丁**：把线上 `lib/ui.js` 里那些手工改动**回到 `src/ui.ts`**（逐项 diff 确认），
   确保仓库是唯一真相源。`ui.js.bak-20260831-072433` 是比对线索。
4. **修复测试基线**：把 §8.1 的竞态查清、让 `pnpm test` 稳定变绿；重写 `migration.spec.ts`。

### P1 — 可靠性工程

5. **端口/配置可移植化**：把 §7 的机器绑定值全部改成外部注入（`config.example.yaml` 已给契约），
   harness seam 用 `DSH_HARNESS_ROOT` 显式配置。
6. **同步 worker 的运维债**（Phase 1 就登记了，一直没做）：
   failed 自动重试、stalled 检测、retired Processing KB 清理、远端 stale Knowledge 清理。
7. **检索相关性闸门**：引入 reranker / LLM 相关性判断，替换 no-op 阈值。见 §8.2。

### P2 — 产品能力（原 Phase 2 候选）

8. Task ↔ Knowledge 关联
9. Memory / PLL
10. Agent workflow（检索 agent 化）
11. 历史数据迁移
12. 移动端真机打磨（正文编辑仍 DEFERRED，见 §4）

### 明确不要做的事

- 不要重新设计 §4 的冻结决策（除非 §5 条件成立）。
- 不要为了"架构优雅"重写 storage/fs seam —— PKW 的持久化语义是本地优先 + harness 托管。
- 不要引入第二个 canonical 存储。
- 不要把 WeKnora 的 remote id 泄漏成用户身份。

---

## 10. 给 Codex 的工作约定

### 10.1 动手前必须做的

```bash
pnpm install
pnpm typecheck          # 必须 exit 0
pnpm test               # 见 §8.1：当前不绿，先记录基线，别用它当"我改坏了"的唯一判据
```

### 10.2 硬约束

- **秘密永不入库**：API key 只走 `weknoraApiKeyRef` → 环境变量 → harness `CredentialProvider`。
  仓库里已经做过全历史 secret 扫描，是干净的；**保持它干净**。
- **用户数据是 canonical**：`notes/` 的 Markdown 和 `attachments/` 的二进制是用户资产。
  任何迁移必须先备份、可回滚、有幂等保证。
- **身份不变量**（§4）任何改动都要在 PR 描述里显式说明为什么没破坏它。
- **UI 只走 RPC**：不要在 `ui.ts` 里直接碰 SQLite / fs / WeKnora。

### 10.3 提交与验收

- 分支：`feat/…`、`fix/…`、`chore/…`；小步提交，信息用 `type(scope): summary`。
- 每个 PR 必须写清：**改了什么 / 为什么 / 怎么验证 / 影响哪些不变量**。
- 验收证据要分层：typecheck ≠ 单测 ≠ 集成 ≠ 部署后真机验证。**没跑过的不要写成通过。**
- 涉及部署的改动，必须附上"重启后 `/pkw` 实际可用"的证据。

---

## 11. 文档索引

| 文档 | 什么时候看 |
| --- | --- |
| `docs/HANDOVER.md`（本文） | 第一次接手 |
| `docs/SYNC_WORKFLOW.md` | 要在两台环境之间同步代码 |
| `docs/CODEBASE_MAP.md` | 找具体代码在哪 |
| `docs/PHASE_1_CLOSURE.md` | 确认某个设计是不是被冻结/拒绝过 |
| `docs/DEBT.md` | 看已登记的债务清单 |
| `docs/INDEX.md` | 其他专项文档的总目录 |
| `docs/CODEBASE_CLEANUP_REPORT.md` | 搞清哪些模块已经被删、为什么 |
| `docs/KNOWLEDGE_*.md` | 三层 Knowledge 模型的决策记录 |
| `docs/portability/*` | 可移植化现状与策略 |
| `README.md` | 快速上手与仓库结构 |

---

## 12. 术语表

| 术语 | 含义 |
| --- | --- |
| **canonical** | 唯一真相源；其余都是可重建的投影 |
| **projection（投影）** | 从 canonical 派生的索引/缓存，允许重建 |
| **OperationContext / OperationCommit** | 变更的上下文与原子提交单元 |
| **durable intent / mapping** | 同步的持久意图与本地↔远端身份映射 |
| **Business Knowledge** | 用户视角的知识对象 = Note + Sources 的聚合 |
| **A2 Retrieval** | Main KB + Processing KB 联邦检索后聚合去重 |
| **DSH / Harness** | DeepSeek Harness，PKW 赖以运行的宿主 |
| **Cordis** | DSH 的插件/服务组合框架（`ctx.plugin()`、`super(ctx,'name')`、`inject`） |
| **profile** | DSH 的一套部署配置（这里是 `web`） |
| **bundle** | 一个可安装的 DSH 扩展包（这里是 `@deepseek-ai/dsh-extension-pkw`） |
