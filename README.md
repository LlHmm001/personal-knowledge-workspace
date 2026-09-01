# Personal Knowledge Workspace (PKW)

一个运行在 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/dsh) 上的**个人知识工作区**宿主插件 bundle。它以 Markdown Note 为 canonical 主体，围绕 Notes / Folders / Tasks / Attachments / WeKnora RAG 检索构建一套本地优先（local-first）的知识管理能力。

Phase 1 已 **CLOSED**。产品能力：Workspace / Notes / Folders / Desktop Editor / Mobile Read-first / Knowledge Home / Unified RAG / Sources(Attachments) / Tasks(Q1–Q4) / Trash。架构边界与已拒绝方向见 [`docs/PHASE_1_CLOSURE.md`](docs/PHASE_1_CLOSURE.md)。

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

运行时接线、frozen architecture、检索核心与测试约定的完整说明见 [`docs/CODEBASE_MAP.md`](docs/CODEBASE_MAP.md)。

## 开发

要求 Node.js + pnpm（`packageManager` 已固定为 `pnpm@11.7.0`）。

```bash
pnpm install       # 安装依赖（使用 pnpm-lock.yaml）
pnpm typecheck     # tsc -p tsconfig.json
pnpm test          # vitest run（单元 + 集成；集成用例需真实 WEKNORA_API_KEY 否则自跳过）
```

每个 service / 纯函数模块在 `tests/*.spec.ts` 下有其单测。

## 配置

`pkw-web`（`PkwWebService.Config`，zod 校验）需要的配置项，由 profile 的 `cordis.patch.yml` 注入：

| 键 | 必填 | 说明 |
| --- | --- | --- |
| `workspacePath` | ✅ | 工作区根目录（`notes/` + `attachments/` 在其下） |
| `kbId` | ✅ | WeKnora 主知识库 id（PKW mirror KB） |
| `weknoraBaseUrl` | ✅ | WeKnora API 地址 |
| `weknoraApiKeyRef` | — | API key 的 credential 引用（环境变量名，如 `WEKNORA_API_KEY`），经 harness `CredentialProvider` 解析 |
| `weknoraApiKey` | — | 明文 key（仅测试 / DI 注入，生产不落） |
| `pollMs` / `retryBaseMs` / `retryMaxMs` / `recoveryGraceAttempts` | — | 同步轮询 / 重试调优，有默认值 |

秘密不进入仓库：生产用 `weknoraApiKeyRef` 指向环境变量，明文 `weknoraApiKey` 仅供测试注入。真实值只应存在于 profile / secrets 中，不在本仓库。

## 文档入口

- [`docs/CODEBASE_MAP.md`](docs/CODEBASE_MAP.md) — 权威代码地图（包职责、运行时接线、检索核心、已移除模块）。
- [`docs/PHASE_1_CLOSURE.md`](docs/PHASE_1_CLOSURE.md) — Phase 1 权威收尾记录（frozen 决策、拒绝方向、遗留债）。
- [`docs/`](docs/) 下其余文件为各专项决策 / 报告，按需查阅。
