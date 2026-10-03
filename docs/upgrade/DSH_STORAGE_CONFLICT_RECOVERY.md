# DSH 插件存储冲突与应急恢复

日期：2026-10-04。用户提供服务器日志，DSH 因 `duplicate loader entry id: storage` 退出并自动重启。用户停止服务后提供 boot-free dump：DSH base 插入 `storage/storage-json/storage-domain`，PKW base 又插入 `storage/storage-sqlite/storage-domain`。Web bundle 还已提供 `workspace`，旧 PKW base 同样重复插入。导出成功不等于加载成功：include 的 insert 只追加，Loader 在启动时拒绝重复标识。

这是发布包与当前 Web 宿主组合的真实兼容缺陷。本机原安装包烟测直接建立测试 Context，没有挂载完整宿主 bundle 树，未覆盖这一组合；原通过结果不能替代服务器启动验收。五项真实 WeKnora 与完整 Harness CI 的未验收状态仍保留。

## 先恢复 DSH

`scripts/recover-dsh-without-pkw.mjs --apply` 只适用于本次已核对的服务器：`deepseek-harness.service`、`/opt/deepseek-harness`、`/root/.dsh/profiles/web`，原启动命令为 Node/tsx 的 CLI `web --host 127.0.0.1 --port 3080 --trusted-host ddmind.duckdns.org`。它必须在服务停止、3080 无监听时运行；路径、命令、配置形态或原存储设置不符就停止，不能套用于其他实例。

脚本创建权限为 0700 的独立配置备份目录，保全 Web manifest、用户补丁、生成 root 配置、home 补丁及私有导出。此备份仅含配置，不是全部资料的冷备。它仅从 Web manifest 的 bundle 列表撤下两个 PKW bundle，保留 dependencies 与已安装包；将剩余 PKW 条目和可确认的 PKW SQLite adapter 追加为 disabled。它不会打开、转换、覆盖或删除资料数据库，也不会调整存储路由或工作区身份。临时停用 PKW 不代表资料完整性已经验收。

更改后用原 CLI 做离线导出，检查同组 ID 唯一、核心存储/JSON adapter/工作区服务唯一且启用、原 JSON adapter 配置和资料路径完全保留、非 PKW 域继续 JSON、DSH 内 PKW 条目停用、无启用的 SQLite adapter。只接受已有绝对 JSON 根或默认 `dshHomePath('storages')` 表达式，不执行未知表达式。未知自定义路由或数据库、迟到用户补丁重新启用 PKW、重复 ID 等情况均拒绝放行，逐项尝试恢复 manifest、补丁和被 dump 重写的生成配置原字节/权限，并如实报告失败项。错误日志和完整导出可能含凭据，只保存在权限为 0600 的本地文件，不应公开发送。

预检检查 root 用户、精确工作目录、manager/unit 的有效 HOME/DSH_HOME/PWD 及运行时注入设置。环境文件、PAM、动态用户、根目录重映射等不明确配置会停止并报告属性名称，不能把这个保守工具当通用系统恢复器。子进程使用核对过的服务环境，不继承终端环境；使用服务器实际 CLI 解析的 app-boot 仅调用 `loadLayeredEnv`，检验两份 `.env` 而不启动插件。静态配置与环境检查仍不等于真实服务启动。

脚本成功也不会自动启动服务。只有退出码 0 且 receipt 为 `configuration-verified-service-not-started`，执行者才能继续 `systemctl start`，随后检查最近完整日志、3080 与 DSH 页面，以及原会话和工作区是否仍可见。DSH 内 PKW 暂停属于应急状态；独立协作服务若存在，仍须另行核对，脚本不管理该服务。

失败时保留现场和备份，不用清库、改 ID、disabled 重复行或重装宿主来绕过冲突。Loader 在禁用检查之前检查重复 ID，因此 disabled 不会解决重复行；改 ID 还可能导致重复服务挂载。

## 正式修复与重新启用 PKW

新的 PKW base 复用 Web 宿主的 storage、storage-domain 和 workspace，只增加 SQLite adapter、pkw-events、pkw-workspace。SQLite 路径继续为 `dshHomePath('pkw', 'pkw.sqlite')`。保持 JSON 默认，仅 `pkw`、`pkw_notes`、`pkw_attachments`、`pkw_tasks`、`pkw_weknora_sync` 五个明确域路由 SQLite。

这不是数据迁移。重新启用前必须核对服务器实际资料根、JSON/SQLite 既有域记录、workspace 注册表的权威位置与稳定 ID、协作身份/空间库、现有定制 routes 和其他服务。不得因路由变化生成新身份或用空数据库替代原内容。whole-config patch 会整体覆盖 routes，现有定制须在后置补丁中完整重述。headless 宿主需要显式提供等效 workspaceRegistry 和依赖，不由此 bundle 隐式新建。

应急备份 manifest 含旧 bundle 列表。不能简单恢复整个旧 manifest，重新装回未修复包；应在已保全配置上采用新不可变包，解除本次明确的 disabled 项，重新离线导出，执行实际宿主启动、数据对账和权限验收。停写、冷备与回退仍按 [登录修复交接](SESSION_LOGIN_FIX.md) 执行，保留用户当前全部内容和配置。

## 证据边界

新增组合回归用实际 Harness 的解析/合并器复现旧补丁两项失败；修复后两项通过。真实 JSON/SQLite 后端与实际域声明验证五个 PKW 域进入 SQLite，已有 JSON workspace 身份及会话投影缓存保留。应急工具另有配置保护、JSON adapter/原路径、失败回退和有效环境检查。安装包验证现在读取已安装 tarball 的 YAML，组合真实宿主 base/web-app，通过同一解析/合并器检查服务唯一及明确路由，拒绝 PKW 源码 symlink；这是新增门禁，不能倒推旧安装包已验证。

| Task | Status | Next step | Completion standard | Verification evidence | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 正式包兼容修复 | 本机通过 | 服务器核对资料根后生成新不可变版本 | 不重复挂载宿主服务；保留身份和资料路径 | 532 项业务通过；5 项真实 WeKnora 跳过；typecheck 通过 | 高 | 合成数据不替代真实对账 |
| 恢复工具 | 本机通过 | 用户在已停服服务器执行冻结脚本 | 配置备份、保守门禁、失败回退、仅配置修改 | 94 项工具通过，其中恢复 8 项/包组合 7 项；真实源码环境预检通过 | 高 | 未直接访问服务器；未知环境停止 |
| 构建与安装包 | 本机通过 | 目标 Harness 重做验收 | 重复输出一致；实际安装包与宿主组合通过 | 10 包/70 输出一致；真实安装组合、HTTP/权限/恢复烟测通过 | 中 | 不读取用户 overlays，不启动完整 DSH |
| 服务器恢复与数据完整性 | 等待执行/输出 | 启动 DSH，核对原会话、工作区、内容 | 持续运行、无新重复 ID、原资料可见 | 尚无本次恢复后服务器证据 | 高 | PKW 重新启用另行验收；配置备份不是资料冷备 |

证据在本机忽略目录 `.pkw-evidence/base-host-*`、`recovery-env-preflight.log`。包验证首次被本机 npm 缓存写权限限制、工具回归首次被 loopback 监听限制阻断；使用私有临时缓存和获准的本机测试环境后全部通过，未弱化业务断言或测试门禁。

本机验证使用合成数据，不代表服务器已恢复。服务器服务启动、原会话/工作区、真实内容和 PKW 重新启用的验收必须逐项提供证据。
