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

# PKW Dependency Strategy — 依赖可移植化

> 目标：减少 `link:` / 绝对 symlink，让 PKW 在生产环境用可解析的版本化依赖安装。

## 1. 当前状态（机器绑定）

| 位置 | 现状 | 问题 |
|---|---|---|
| profile `package.json` | `"@deepseek-ai/dsh-pkw-web": "link:/opt/deepseek-harness/packages/pkw/web"` | ❌ 绝对路径 `link:` |
| harness 仓库 | `packages/pkw -> /LlHmm9527/.../packages/pkw` symlink | ❌ 绝对 symlink |
| PKW 内部 7 包 | `workspace:*` 互相引用 | ✅ 正常（monorepo 内部协议） |
| PKW 外部 npm 依赖 | `vditor`、`zod` | ✅ registry，可解析 |

**结论**：机器绑定只集中在「把 PKW 挂进 harness」的那一层（`link:` + symlink），PKW 内部依赖是干净的。

## 2. 目标状态（可移植）

- **生产安装**：`@deepseek-ai/dsh-pkw-web` 作为**版本化包**（`1.0.0`），从 registry 或 `git+ref` 解析。
- **开发模式**：本地 monorepo 用 `workspace:*` / `link:`（仅开发者本机，不入生产 profile）。
- **无绝对 symlink**：挂载关系由 `extension.json` 的 `installHooks`（或 profile 声明）重建，不再 `ln -s` 写死路径。

## 3. 迁移步骤

1. **发布 PKW 子包**：给 10 个 `@deepseek-ai/dsh-pkw-*` 打 `1.0.0`（当前 workspace 内 `workspace:*` 改 `1.0.0`）。
2. **profile 改用版本化依赖**：
   `"link:/opt/deepseek-harness/packages/pkw/web"` → `"1.0.0"`（或 `"git+https://github.com/LlHmm001/zhishiku.git#pkw-extension"`）。
3. **移除 harness 内 symlink**：`packages/pkw` 不再手工软链；若仍需要开发态挂载，用 `installHooks.symlinks` 声明式重建。
4. **保留开发模式**：`pnpm-workspace` 保留 `workspace:*` 用于本地联调；生产 profile 用 registry 版本。

## 4. 不能立刻发布时的降级方案

- 生产 profile 用 `git+ref` 依赖（指向 `zhishiku` 的 `pkw-extension` 子目录/分支），避免绝对路径；
- 仍保留 `link:` 仅作**开发者本机**模式，且路径用 `${DSH_HOME}` 或相对路径表达，而非 `/opt/...`。
