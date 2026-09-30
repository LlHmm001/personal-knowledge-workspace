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

# PKW Portable Build Report

> Phase 7.1 Step 3：隔离环境 clean build 验证（fresh install + tsc）。

## 验证环境

- 隔离工作树 `/LlHmm9527/pkw-portable`（PKW `portable` 分支）
- fresh pnpm store + cache（`/tmp/pkw-store*`、`/tmp/pkw-cache*`），未用生产 node_modules/store

## 结果

| 步骤 | 结果 |
|---|---|
| fresh `pnpm install`（原始 devDeps） | ✅ 成功（typescript 6.0.3 / @types/node / vitest / vite-tsconfig-paths） |
| tsconfig 无机器绝对路径 | ✅（grep `/opt`、`/LlHmm9527` 均空） |
| `tsc -p tsconfig.json` 类型检查 | ✅ **exit 0**（相对路径解析 harness 通过） |

## 关键发现

1. **npm 依赖路线不可行**：给 package.json 加 `@deepseek-ai/*` 依赖后 `pnpm install` 404 ——
   harness 框架包在 npm 上的依赖图不完整（`@deepseek-ai/dsh-type-meta` 未发布）。
   → harness 必须作为 **git checkout** 引用，而非 npm 包。
2. **相对路径路线可行**：tsconfig 用相对路径引用 harness 兄弟目录（`../deepseek-harness/...`）
   与 PKW 自身包（`packages/pkw/*/src`），`tsc` 全绿通过。

## 部署假设（新增）

- harness checkout 需位于 PKW 仓库的**兄弟目录** `../deepseek-harness`（由 dsh-updater 在部署时 clone）。
- 这是「相对约定」而非「机器绝对路径」，任意 clean environment 均可满足（clone harness 到该位置）。

## 结论

PKW 构建系统的机器绝对路径已消除，类型检查在隔离环境通过。剩余为「harness 兄弟目录」这一部署约定。
