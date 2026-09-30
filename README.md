# Personal Knowledge Workspace (PKW)

一个运行在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 上的**个人知识工作区**宿主插件 bundle。
以 **Markdown Note 为唯一真相源（canonical）**，围绕 Notes / Folders / Tasks / Attachments / WeKnora RAG
构建一套**本地优先（local-first）**的知识管理能力。

> **状态：Phase 1 CLOSED / ACCEPTED。**
> 产品面：Workspace / Notes / Folders / 桌面编辑器 / 移动端只读优先 / Knowledge Home /
> 统一 RAG 检索 / Sources（附件）/ Tasks（Q1–Q4）/ Trash。
> 架构边界与已拒绝方向见 [`docs/PHASE_1_CLOSURE.md`](docs/PHASE_1_CLOSURE.md)。

> **⚠️ 接手前必读**：本项目当前存在「仓库源码 ≠ 线上运行产物」的部署缺口，
> 线上补丁回流与部署验收仍需目标环境。**请先读 [`docs/HANDOVER.md`](docs/HANDOVER.md)** ——
> 它给出了完整的项目交代、冻结边界、已知问题和升级路线。

---

## 核心模型：三层 Knowledge

```
Main Knowledge       = Note 正文/上下文投影
Processing Knowledge = 附件二进制经 OCR/parser 解析出的 chunks/summary（独立 Processing KB）
        ↓ 聚合
Business Knowledge   = 用户看到的对象 = Note + 它的 Sources
```

检索（A2 Retrieval）：`Main KB hybridSearch` + `Processing KB` → 按 businessKey 聚合去重 →
active canonical 过滤 → 相关性下限 → 结果 + trace。

**关键语义**：WeKnora 只是解析/索引/检索引擎，其 remote id **永远不是用户身份**；
**本地保存/读取绝不依赖 WeKnora 可用性**。

---

## 仓库结构

pnpm workspace monorepo。每个子包 = `@deepseek-ai/dsh-pkw-<name>`，位于 `packages/pkw/*`：

| 包 | 职责 |
| --- | --- |
| `domain` | runtime-free 领域基础：标识符 / OperationContext / DomainEvent、zod spec、Markdown 纯函数 |
| `events` | durable 事件库（`ctx.pkwEvents`，OperationCommit 原子追加 + 幂等 + post-commit signal） |
| `workspace` | workspace 布局 + `ctx.fs` 路径安全 + OperationContext 工厂（`ctx.pkwWorkspace`） |
| `notes` | Markdown canonical、NoteIndex 投影、folder CRUD、trash/restore（`ctx.pkwNotes`） |
| `tasks` | TaskMatrix + Task store，Eisenhower 象限派生不落库（`ctx.pkwTasks`） |
| `attachments` | binary canonical + catalog 投影（`ctx.pkwAttachments`） |
| `weknora` | WeKnora 0.7.1 REST adapter（`ctx.pkwWeKnora`） |
| `weknora-sync` | local-first 同步 worker + `searchWithTrace` 检索核心（`ctx.pkwWeKnoraSync`） |
| `web` | Host 插件 + 浏览器 UI（`/pkw` 页面、`/pkw/api` RPC、`/pkw/attachment` 字节路由） |
| `base` | Host-plane bundle（`cordis.patch.yml`，组合 storage/workspace/pkw 服务） |

运行时接线、frozen architecture、检索核心与测试约定的完整说明见
[`docs/CODEBASE_MAP.md`](docs/CODEBASE_MAP.md)。

---

## 开发

要求 Node.js 22.19+ 或 Node 24 与 pnpm（`packageManager` 已固定为 `pnpm@11.7.0`）。

```bash
export DSH_HARNESS_ROOT=/opt/deepseek-harness # 或已构建的 Harness checkout 绝对路径
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test          # 工具测试 + Vitest；真实 WeKnora 集成需凭据，否则自跳过
pnpm build         # 十个包输出 lib/*.js 与声明
pnpm verify:build  # 重复构建哈希与陈旧产物检查
pnpm verify:packed # 打包、临时 registry 安装、普通 Node 加载与 HTTP/RPC
```

> **`pnpm typecheck` 需要 harness checkout。** PKW 的 tsconfig 通过
> `/opt/deepseek-harness` 这个软链解析 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-*`。
> 本机开发请设置 `DSH_HARNESS_ROOT`，详见 [`docs/HANDOVER.md`](docs/HANDOVER.md) §7。

> 同步并发回归、启用后的 storage 契约测试及未完成项见
> [`docs/DELIVERY_STATUS.md`](docs/DELIVERY_STATUS.md)。构建/部署命令与验收边界见
> [`docs/BUILD_AND_DEPLOY.md`](docs/BUILD_AND_DEPLOY.md)。本地通过不代表线上已升级。

每个 service / 纯函数模块在 `tests/*.spec.ts` 下有其单测。

---

## 配置

`pkw-web`（`PkwWebService.Config`，zod 校验）需要的配置项，由 profile 的 `cordis.patch.yml` 注入。
填写模板见 [`config.example.yaml`](config.example.yaml)，部署 manifest 的只读快照见
[`docs/deploy/`](docs/deploy/README.md)。

| 键 | 必填 | 说明 |
| --- | --- | --- |
| `workspacePath` | ✅ | 工作区根目录（`notes/` + `attachments/` 在其下） |
| `kbId` | ✅ | WeKnora 主知识库 id（PKW mirror KB） |
| `weknoraBaseUrl` | ✅ | WeKnora API 地址 |
| `weknoraApiKeyRef` | — | API key 的 credential 引用（环境变量名，如 `WEKNORA_API_KEY`），经 harness `CredentialProvider` 解析 |
| `weknoraApiKey` | — | 明文 key（仅测试 / DI 注入，**生产不落**） |
| `pollMs` / `retryBaseMs` / `retryMaxMs` / `recoveryGraceAttempts` | — | 同步轮询 / 重试调优，有默认值 |

**秘密不进入仓库**：生产用 `weknoraApiKeyRef` 指向环境变量，明文 `weknoraApiKey` 仅供测试注入。
真实值只应存在于 profile / secrets 中。全历史 secret 扫描已通过，请保持。

---

## 文档入口

- **[`docs/HANDOVER.md`](docs/HANDOVER.md) — 新接手者从这里开始**：项目交代、冻结边界、
  部署现实、已知问题、升级路线。
- [`docs/SYNC_WORKFLOW.md`](docs/SYNC_WORKFLOW.md) — 本机开发端 ↔ 云端容器通过 GitHub 的双向同步流程。
- [`docs/CODEBASE_MAP.md`](docs/CODEBASE_MAP.md) — 权威代码地图（包职责、运行时接线、检索核心、已移除模块）。
- [`docs/PHASE_1_CLOSURE.md`](docs/PHASE_1_CLOSURE.md) — Phase 1 权威收尾记录（frozen 决策、拒绝方向、遗留债）。
- [`docs/DEBT.md`](docs/DEBT.md) — 已登记债务清单。
- [`docs/INDEX.md`](docs/INDEX.md) — 其余专项决策 / 报告的总目录。

---

## 许可证

[Apache-2.0](LICENSE)
