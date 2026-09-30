# 贡献指南

本项目是一个单人主导的知识工作区项目，但欢迎 issue 与 PR。请先读
[`docs/HANDOVER.md`](docs/HANDOVER.md) 了解架构边界。

## 动手之前

```bash
pnpm install
pnpm typecheck     # 必须 exit 0
pnpm test          # 当前基线不稳定，见 docs/HANDOVER.md §8.1
```

## 硬约束

1. **不要重新设计冻结的架构决策**（[`docs/PHASE_1_CLOSURE.md`](docs/PHASE_1_CLOSURE.md) §1）。
   除非触发 §5 的 reopen 条件，否则只在其上扩展。
2. **身份不变量**：`NoteId` / `AttachmentId` 稳定；`relativePath` 与文件名**不是**身份；
   `path` 是位置不是身份。
3. **秘密永不入库**。API key 只允许通过 `weknoraApiKeyRef` → 环境变量 → harness
   `CredentialProvider` 解析。
4. **用户数据（`notes/` 的 Markdown、`attachments/` 的二进制）是 canonical 资产**。
   任何迁移必须可备份、可回滚、幂等。
5. **浏览器 UI 只走 RPC**（`POST /pkw/api`）。不要在 `ui.ts` 里直接访问 SQLite / fs / WeKnora。

## 提交与 PR

- 分支命名：`feat/…`、`fix/…`、`chore/…`、`docs/…`。
- 提交信息：`type(scope): summary`，例如 `fix(pkw-sync): …`。
- PR 描述必须包含四项：
  1. **改了什么**
  2. **为什么**（对应哪个 issue / 哪条债务）
  3. **怎么验证**（贴实际命令与结果）
  4. **影响哪些不变量**（是否触及 §2 的约束）

## 验证的标准

证据要分层，不要混为一谈：

| 层级 | 含义 |
| --- | --- |
| typecheck | 类型能过，不代表行为正确 |
| 单元测试 | 纯逻辑正确 |
| 集成测试 | 服务接线正确（部分用例需真实 `WEKNORA_API_KEY`，否则自跳过） |
| 部署后验证 | 重启 DSH 后 `/pkw` 实际可用 |

**没跑过的不要写成通过。** 调用返回成功 ≠ 业务成功。

## 报告问题

请使用 issue 模板，并说明：复现步骤、期望 vs 实际、环境（分支/commit）、
以及你实际观察到的日志或截图。
