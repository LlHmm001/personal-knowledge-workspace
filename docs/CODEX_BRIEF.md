你是接管 PKW（Personal Knowledge Workspace）项目的开发 agent。请先完整读完这份简报再动手。

════════════════════════════════════════
一、这是什么项目
════════════════════════════════════════

PKW 是一个跑在 DSH（DeepSeek Harness）之上的「个人知识工作区」宿主插件扩展。
pnpm workspace monorepo，10 个包 `@deepseek-ai/dsh-pkw-*`，位于 `packages/pkw/*`。

核心模型（三层 Knowledge，这是整个项目的心脏，别搞错）：

  Main Knowledge       = Note 正文/上下文投影（一个 Note 最多一个）
  Processing Knowledge = 附件二进制经 OCR/parser 解析出的 chunks/summary，住在独立 Processing KB
          ↓ 聚合
  Business Knowledge   = 用户真正看到的对象 = Note + 它的 Sources（附件）

  检索（A2 Retrieval）：Main KB hybridSearch + Processing KB → 按 businessKey 聚合去重
  → active canonical 过滤 → 相关性下限 → 结果 + trace

关键语义：
- Markdown Note = canonical；Attachment binary = canonical；Task Store = canonical。
- WeKnora 只是解析/索引/检索/摘要引擎，它给的 remote KnowledgeId **永远不是用户身份**，不得泄漏给 UI。
- **本地保存/读取绝不依赖 WeKnora 可用性**。WeKnora 挂了，笔记照样读写，只是同步 pending。
- Folder = 真实目录 / relativePath 派生，**没有 Folder entity**。

════════════════════════════════════════
二、第一步：读这两份文档，不要跳过
════════════════════════════════════════

  docs/HANDOVER.md      ← 权威交接文档。§4 冻结决策 §6 部署现实 §8 质量基线 §9 升级路线
  docs/CODEBASE_MAP.md  ← 具体代码在哪

§4「冻结的架构决策」和 §5「什么情况下才能重开 Foundation」是硬边界，动手前必须先读。

════════════════════════════════════════
三、当前质量基线（诚实版，别被骗）
════════════════════════════════════════

  pnpm typecheck   ✅ 干净通过
  pnpm test        ❌ 不稳定：失败数在 1~6 之间浮动

不稳定集中在 packages/pkw/weknora-sync/tests/sync.spec.ts，根因方向是后台 sync worker
按 pollMs 轮询、测试用 vi.waitFor 等它收敛，并发下等待窗口不够。典型失败用例：
third-state drift / marks never-synced entities dirty / materializes the Attachment
Knowledge summary。

⚠️ 不要为了让 CI 变绿而删测试或放宽断言。先把竞态真正定位清楚，再决定修测试还是修 worker。

另外 packages/pkw/notes/tests/migration.spec.ts 已被 describe.skip 停用（不是删除），
它依赖当前 harness 已不存在的 storage API。主题仍然重要：PKW 的 domain spec 停在
version: 3 且没有迁移路径，而 harness 对版本不匹配的 medium 是**直接拒绝打开**的。
这意味着**旧版 PKW 写出的数据在新版上会被拒绝打开** —— 潜在数据可用性风险。

════════════════════════════════════════
四、最重要的一件事：源码 ≠ 线上
════════════════════════════════════════

线上 DSH 加载的 PKW 不是本仓库源码，而是：
  /root/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-pkw-*/lib/*.js

事实：
- 本仓库**没有 build 脚本**，**没有部署脚本**。
- 线上产物来自本地 npm registry（localhost:4873），只有一个版本，发布于 2026-08-22。
- lib/ui.js 的 mtime 是 08-25，旁边还有 ui.js.bak-* —— **它被手工改过**。
- 旧软链 /opt/deepseek-harness/packages/pkw **已经不存在**。

结论：**你改了仓库，线上不会有任何变化。** 而且线上部分行为来自手改产物，
排查 bug 前必须先确认你在看哪个产物（源码 or lib/*.js）。

════════════════════════════════════════
五、你的任务（按依赖排序，P0 必须先做）
════════════════════════════════════════

【P0-1】建立构建管线
  为全部 packages/pkw/* 增加 build 脚本（src/*.ts → lib/*.js），根 package.json 加 pnpm build。
  验收：`pnpm build` 全仓产出 lib/*.js，且可重复执行。

【P0-2】建立部署脚本
  一条命令完成：build → publish 到本地 registry(localhost:4873) → profile install → 重启验证 /pkw。
  验收：替换掉现在的手工粘贴流程，写进仓库。

【P0-3】止血手工补丁
  把线上 lib/ui.js 里的手工改动**逐项 diff 确认后回流到 src/ui.ts**，
  确保仓库是唯一真相源。比对线索：lib/ui.js.bak-20260825-004526。
  验收：给出手工改动清单 + 回流结果。

【P0-4】让测试基线稳定
  定位并修复 weknora-sync 的并发竞态；按当前 harness storage API 重写 migration.spec.ts
  并重新启用。验收：`pnpm test` 连续多次全绿。

【P1-5】可移植化
  把机器绑定值改成外部注入：profile bundle 里的 kbId / weknoraBaseUrl 目前硬编码。
  harness seam 建议用环境变量 DSH_HARNESS_ROOT 显式配置（默认 /opt/deepseek-harness）。
  ⚠️ 不要盲目"去绝对路径"——tsconfig 里的 /opt/deepseek-harness 是**刻意的**设计，
  部署把它指向当前 release，比版本化的 /opt/dsh-releases/v-* 更稳。
  历史上 portable 分支改成兄弟目录 ../deepseek-harness，但**该布局在部署环境不存在且 tsc 会失败**。

【P1-6】同步 worker 运维债
  failed 自动重试 / stalled 检测 / retired Processing KB 清理 / 远端 stale Knowledge 清理。

【P1-7】检索相关性闸门
  现状：搜罕见词第 1 条对、后面若干条无关。根因已查清——WeKnora hybrid-search
  **无服务端阈值**，真假分数区间重叠，任何静态阈值切不干净；当前相对下限 top*0.25 实际是 no-op。
  **正确修法是需要真正的 reranker / LLM 相关性闸门，不是调阈值。**

════════════════════════════════════════
六、硬约束（违反就是破坏项目）
════════════════════════════════════════

1. 不要重新设计 docs/HANDOVER.md §4 的冻结决策，除非触发 §5 的 reopen 条件。
   已拒绝且不要自动重开：DOCX canonical / DOCX 主传输 / 绝对路径作为资产身份 /
   PKW→WeKnora resource:// 集成 / A1 把附件物化进 Main Knowledge。

2. 身份不变量永不回归：
   NoteId 稳定；relativePath **可变，永远不是身份**；
   AttachmentId(att_<12hex>) 稳定；**文件名只是展示元数据，永远不是身份**；
   **path 是位置，不是身份**。

3. 秘密永不入库。API key 只走 weknoraApiKeyRef → 环境变量 → harness CredentialProvider。
   仓库已做过全历史 secret 扫描且 CI 会持续守这条，**保持它干净**。

4. 用户数据（notes/ 的 Markdown、attachments/ 的二进制）是 canonical 资产。
   任何迁移必须可备份、可回滚、幂等。

5. 浏览器 UI 只走 RPC（POST /pkw/api）。不要在 ui.ts 里直接碰 SQLite / fs / WeKnora。

6. 不要引入第二份 canonical 存储。不要为"架构优雅"重写 storage/fs seam。

════════════════════════════════════════
七、工作方式
════════════════════════════════════════

- 开工前：
    pnpm install && pnpm typecheck && pnpm test    # 先记录基线，别用 test 当唯一判据
- 分支：feat/* fix/* chore/*；提交信息 type(scope): summary。
- PR 描述必须含四项：改了什么 / 为什么 / 怎么验证 / 影响哪些不变量。
- 证据要分层：typecheck ≠ 单测 ≠ 集成 ≠ 部署后验证。**没跑过的不要写成通过。**
  调用返回成功 ≠ 业务成功。
- 涉及部署的改动，必须附上"重启后 /pkw 实际可用"的证据。

════════════════════════════════════════
八、远端与同步
════════════════════════════════════════

  仓库：https://github.com/LlHmm001/personal-knowledge-workspace   分支：main

同步铁律：GitHub 是唯一中转站，两端都不直接改对方的文件。
开工前永远先 `git fetch origin && git status`；有未推送提交或远端有更新时，先同步再动手。
详见 docs/SYNC_WORKFLOW.md。

易冲突文件：packages/pkw/web/src/ui.ts（大文件、改动密集）。改它之前先 pull，改完立刻推。

════════════════════════════════════════
开始之前，先用一段话回答我：
════════════════════════════════════════

1. 三层 Knowledge 分别是什么、谁是谁的投影？
2. 为什么"改了仓库线上也不会变"？你打算怎么解决？
3. P0-1 到 P0-4 里，哪一项你判断风险最高，为什么？

回答完再动手。
