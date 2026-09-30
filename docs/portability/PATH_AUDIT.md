> **档案状态：历史记录。** 本文件来自旧的 `portable` 分支（2026-08 的可移植化工作），
> 保留它是因为其中的分析结论仍然有效。**但它描述的部分现状已经改变**，阅读时请注意：
>
> - 文中提到的 harness 内 `packages/pkw` 软链**已经不存在**。
> - `tsconfig` 目前**刻意**使用 `/opt/deepseek-harness` 软链（部署把它指向当前 release），
>   而不是文中建议的兄弟目录 `../deepseek-harness` —— 后者在部署环境并不存在。
> - 配置注入的目标方案见 [`config.example.yaml`](../../config.example.yaml)；
>   当前生产部署的真实快照见 [`docs/deploy/`](../deploy/)。
>
> 权威的现状与升级路线以 [`docs/HANDOVER.md`](../HANDOVER.md) 为准。

---

# PKW Path Audit — 构建系统路径耦合

> Phase 7.1 Step 1。扫描 `tsconfig.json` / `tsconfig.base.json` 及全部 package tsconfig 的绝对路径。

## 扫描结果

| 文件 | 机器绝对路径 | 数量 |
|---|---|---|
| `tsconfig.json` | `baseUrl: /opt/deepseek-harness` + 9 个 `@deepseek-ai/dsh-pkw-*` → `/LlHmm9527/Personal Knowledge Workspace/...` | 1 + 9 |
| `tsconfig.base.json` | 同上（baseUrl + 9 个 dsh-pkw-* 绝对路径） | 1 + 9 |
| 各 package 内 tsconfig | 无（未发现独立 package tsconfig） | 0 |

## 分类

| 层 | 内容 | 分类 |
|---|---|---|
| PKW 自身包路径 | `@deepseek-ai/dsh-pkw-*` → `/LlHmm9527/.../packages/pkw/*/src` | **build/typecheck 依赖**（tsc + vitest 源解析） |
| harness 框架 baseUrl | `baseUrl: /opt/deepseek-harness`，其下 `./vendor/*`、`./packages/*/lib/types` 解析 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-*` | **build/typecheck 依赖** |
| runtime | 无（运行时不读这些 tsconfig 路径） | — |
| test-only | `tsconfig.base.json` 被 vitest（vite-tsconfig-paths）使用 | typecheck + test |

## 关键发现

1. **PKW 自身包路径是绝对路径**（`/LlHmm9527/...`），因为 PKW 曾以 symlink 形式嵌在 harness checkout 内 typecheck。
2. **harness 框架包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-*` 等 14 个）已发布到 npm**：
   - `@deepseek-ai/cordis@4.0.1`、`cosmokit@1.8.2`、`schemastery@3.18.1`、`cordis-plugin-timer@1.1.3`
   - `@deepseek-ai/dsh-*@0.0.1-rc.1`
3. 但 PKW 的 `package.json` **没有声明这些依赖**，全靠 tsconfig `paths` 指向 harness checkout。

## 修复策略

- **PKW 自身包**：绝对路径 → 仓库内相对路径（`packages/pkw/*/src`）。
- **harness 框架**：从 `paths` 移除，改为在 `package.json` 声明依赖，用 node_modules 解析（包已在 npm）。
- `baseUrl`：`/opt/deepseek-harness` → `.`（相对）。
