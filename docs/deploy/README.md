# 部署参考物（只读快照）

> ⚠️ **这两个文件是当前生产部署的只读快照，不是本仓库的可编辑源码。**
> 把它们放进仓库的唯一目的：让接手者能看到**线上真正加载的 manifest 长什么样**，
> 因为本仓库目前**还不产出它们**（没有 build/发布管线，见 `docs/HANDOVER.md` §6）。

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `extension.live.json` | `/root/.dsh/extensions/pkw/extension.json` | DSH 加载的扩展 manifest 快照 |
| `cordis.patch.live.yml` | `/root/.dsh/extensions/pkw/bundle/cordis.patch.yml` | profile 实际应用的 bundle patch 快照 |

## 已做的处理

- `cordis.patch.live.yml` 里的真实 `kbId` 已替换为占位符。**其余内容逐字保留。**
- 两个文件都**不参与构建**，也不被任何脚本读取。

## 为什么不存在 `extension.json` 提案版

早期 `portable` 分支曾产出过一份 `extension.json` 提案，但它的 `configSchema`
与线上实际加载的 manifest **形状不同**（提案用 `{ type, required, secret, default }`
的扁平对象，线上用的是标准 JSON Schema 的 `properties`）。

仓库里同时存在两份互相矛盾的 manifest，只会让接手者改错文件。
因此**没有**把提案版放进仓库；配置契约改用两处表达，二者是一致的：

- [`config.example.yaml`](../../config.example.yaml) — 人类可填写的模板
- [`docs/HANDOVER.md`](../HANDOVER.md) §3 / `README.md` 的配置表 — 字段语义与必填性

## 给 Codex 的提示

建立构建/发布管线时，**目标状态**应该是：仓库产出 `extension.json` + `cordis.patch.yml`，
部署时复制到 `/root/.dsh/extensions/pkw/`，并让 `configSchema` 真正把
`kbId` / `weknoraBaseUrl` 标成 `required`、`weknoraApiKey` 标成 secret——
即把这两个快照里"机器绑定值硬编码在 patch 里"的现状替换掉。
