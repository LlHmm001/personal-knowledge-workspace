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

# PKW Configuration Migration — 旧配置 → 新配置

> 目标：把 profile 里写死的机器绑定值，迁移到环境变量 / config schema。
> 原则：真实值不落 git；`secret` 字段只走环境变量。

## 旧配置（现状，`/root/.dsh/profiles/web/cordis.patch.yml`）

```yaml
config:
  workspacePath: !!js dshHomePath('pkw-workspace')
  kbId: '<真实部署的 KB id — 已脱敏>'        # ← 机器绑定（硬编码）
  weknoraBaseUrl: 'http://127.0.0.1:18088/api/v1'      # ← 机器绑定（硬编码）
  weknoraApiKeyRef: 'WEKNORA_API_KEY'                  # ← 已环境引用
  weknoraApiKey: ''
  pollMs: 2000
  retryBaseMs: 5000
  retryMaxMs: 120000
  recoveryGraceAttempts: 3
```

## 新配置（目标）

| 旧值 | 新形式 | 分类 |
|---|---|---|
| `kbId: '<真实部署的 KB id>'` | `${PKW_KB_ID}`（环境变量 / configSchema `kbId`） | ✅ 需参数化 |
| `weknoraBaseUrl: 'http://127.0.0.1:18088/api/v1'` | `${WEKNORA_BASE_URL}`（环境变量 / configSchema `weknoraBaseUrl`） | ✅ 需参数化 |
| `workspacePath: dshHomePath('pkw-workspace')` | `${DSH_HOME}/pkw-workspace` | ✅ 保持（已相对） |
| `weknoraApiKeyRef: 'WEKNORA_API_KEY'` | `WEKNORA_API_KEY`（secret，仅环境变量） | ✅ 保持 |
| `weknoraApiKey: ''` | 由环境注入，不落值 | ✅ 保持 |
| `pollMs/retryBaseMs/retryMaxMs/recoveryGraceAttempts` | 默认值写进 `configSchema`，可覆盖 | ✅ 固定 |

## 迁移动作

1. 在 `extension.json` 的 `configSchema` 声明 `kbId` / `weknoraBaseUrl` 为 `required`，`weknoraApiKey` 为 `required + secret`。
2. 提供 `config.example.yaml`（本文件同级）作为填写模板。
3. 部署时从 `secrets.template.yaml` + 环境变量注入 `PKW_KB_ID` / `WEKNORA_BASE_URL` / `WEKNORA_API_KEY`。
4. 删除 profile `cordis.patch.yml` 里的两行硬编码值，改用占位符或交由安装器注入。
