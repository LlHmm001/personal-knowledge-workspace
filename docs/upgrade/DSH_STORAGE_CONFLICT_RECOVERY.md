# DSH 插件存储冲突与应急恢复

日期：2026-10-04。用户提供服务器日志，DSH 因 `duplicate loader entry id: storage` 退出并自动重启。用户停止服务后提供 boot-free dump：DSH base 插入 `storage/storage-json/storage-domain`，PKW base 又插入 `storage/storage-sqlite/storage-domain`。Web bundle 还已提供 `workspace`，旧 PKW base 同样重复插入。导出成功不等于加载成功：include 的 insert 只追加，Loader 在启动时拒绝重复标识。

这是发布包与当前 Web 宿主组合的真实兼容缺陷。本机原安装包烟测直接建立测试 Context，没有挂载完整宿主 bundle 树，未覆盖这一组合；原通过结果不能替代服务器启动验收。五项真实 WeKnora 与完整 Harness CI 的未验收状态仍保留。

## 先恢复 DSH

`scripts/recover-dsh-without-pkw.mjs --apply` 只适用于本次已核对的服务器：`deepseek-harness.service`、`/opt/deepseek-harness`、`/root/.dsh/profiles/web`，原启动命令为 Node/tsx 的 CLI `web --host 127.0.0.1 --port 3080 --trusted-host ddmind.duckdns.org`。它必须在服务停止、3080 无监听时运行；路径、命令、配置形态或原存储设置不符就停止，不能套用于其他实例。

脚本创建权限为 0700 的独立配置备份目录，保全 Web manifest、用户补丁、生成 root 配置、home 补丁及私有导出。此备份仅含配置，不是全部资料的冷备。它仅从 Web manifest 的 bundle 列表撤下两个 PKW bundle，保留 dependencies 与已安装包；将剩余 PKW 条目和可确认的 PKW SQLite adapter 追加为 disabled。它不会打开、转换、覆盖或删除资料数据库，也不会调整存储路由或工作区身份。临时停用 PKW 不代表资料完整性已经验收。

更改后用原 CLI 做离线导出，检查同组 ID 唯一、核心存储/JSON adapter/工作区服务唯一且启用、原 JSON adapter 配置和资料路径完全保留、非 PKW 域继续 JSON、DSH 内 PKW 条目停用、无启用的 SQLite adapter。只接受已有绝对 JSON 根或默认 `dshHomePath('storages')` 表达式，不执行未知表达式。未知自定义路由或数据库、迟到用户补丁重新启用 PKW、重复 ID 等情况均拒绝放行，逐项尝试恢复 manifest、补丁和被 dump 重写的生成配置原字节/权限，并如实报告失败项。错误日志和完整导出可能含凭据，只保存在权限为 0600 的本地文件，不应公开发送。

预检检查 root 用户/组、精确工作目录、manager/unit 的有效 HOME/DSH_HOME/PWD 及运行时注入设置。未知环境文件、PAM、动态用户、根目录重映射等不明确配置会停止并报告属性名称，不能把这个保守工具当通用系统恢复器。子进程使用核对过的服务环境，不继承终端环境；使用服务器实际 CLI 解析的 app-boot 仅调用 `loadLayeredEnv`，检验两份 `.env` 而不启动插件。静态配置与环境检查仍不等于真实服务启动。

2026-10-04 现场补证：初版在任何配置修改前因 EnvironmentFiles 拦下。用户提供 systemd 249、root、工作目录 `/opt/deepseek-harness`、服务 inactive/dead，以及唯一 mandatory 环境文件 `/LlHmm9527/memory-hub/state/keys/agent-journal.env`。新版仅支持这一个已确认声明，保留原文件和 unit。

工具先私下检查合法 UTF-8、单行赋值/保守引用语法及 root 所有者/不可组或全局写入；复杂格式或启动注入键在启动探针前拒绝。读取前后核对 dev/ino/mode/uid/gid/size/mtime/ctime，使用读取到的固定字节创建 0600 私有副本，防止检查与解析间原文件替换。基础环境另存私有层在前，原文件副本在后，复用 systemd 原生解析及覆盖顺序，不手工 source。无凭据进入命令参数、description、终端回执。完整环境 JSON 仅经父进程捕获的管道进入内存，失败不输出异常中的原 stdout/stderr。[systemd 249 管道规则](https://github.com/systemd/systemd/blob/v249/man/systemd-run.xml)、[环境文件覆盖规则](https://github.com/systemd/systemd/blob/v249/man/systemd.exec.xml)。

独立随机临时 unit 只运行 Node 环境收集，使用 20 秒运行上限；结束或客户端超时后只清理该探针。预检前后及最终更改后核对原环境文件字节/身份与 unit 设置未漂移，再核对有效目录并执行原 CLI 的环境预检和配置导出。探针 runtime ID 等元数据与原 unit 不同，因此只作为目录/配置预检证据。私有备份现在含这两份环境副本（可能含凭据），仍不是资料冷备。

后续现场执行通过原生环境收集，但运行时预检因软链接路径误判退出；服务器本地只读诊断确认目录不匹配错误与部署软链接同时存在。脚本原来要求 Node 的 `process.cwd()` 文本等于 unit 的逻辑工作目录；Node 返回软链接指向的物理目录，合法发布链接因此被拒绝。此时尚未调用首次配置 dump，也未替换 manifest/补丁/生成配置；仅创建私有配置备份、环境副本及错误日志，服务未启动。

修复固定初始物理路径和目录 dev/ino，核对逻辑工作目录、Node cwd 以及存在时的 PWD 都指向同一快照；读取身份时核对逻辑路径与物理目标一致，预检在 `.env` 加载前后重查，配置操作前后也持续拒绝链接切换或同路径目录替换。子进程工作目录、CLI 入口及 YAML 依赖定位固定到初始物理目录；探针通过目录保护后才动态导入 Harness 模块，每次配置 dump 前复查原输入，避免切换链接后先执行另一个版本。unit 的逻辑 WorkingDirectory 与 HOME/DSH_HOME 约束保持原门禁，不移除目录检查。预检失败只公开固定错误类别；完整错误留在私有日志，空 stderr 时仍保留白名单错误代码。

本机是 macOS，没有正在运行的 Linux/systemd 249；原生 249 支持依据来自版本对应的官方源码及本次现场环境收集走过的阶段，完整恢复和服务启动仍待新脚本现场验收。本机 18 项恢复回归覆盖原门禁、路径/文件格式/注入拒绝、正确覆盖顺序、秘密不入参数/错误、探针清理、文件身份漂移、真实 Node 软链接 cwd、发布链接切换/同路径替换、生成预检的目录及 HOME 拒绝。生成预检测试使用临时模块，不计作目标服务器完整 Harness 启动成功。

独立复核另用已知真实 Harness 模块、临时发布目录/软链接及隔离 `.env` 执行最终生成预检：空环境和普通业务变量通过，禁止的 DSH_HOME 声明及链接切换被拒绝，tsx 动态导入解析到实际源码；未调用 boot 或读取用户环境文件。这证明本机模块解析与预检组合，仍不能替代目标服务器启动和资料验收。

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
| 正式包兼容修复 | 本机通过 | 服务器核对资料根后生成新不可变版本 | 不重复挂载宿主服务；保留身份和资料路径 | 536 项业务通过；5 项真实 WeKnora 跳过；typecheck 通过 | 高 | 合成数据不替代真实对账 |
| 恢复工具 | 本机通过；旧预检现场失败已定位 | 用户在已停服服务器执行新冻结脚本 | 配置备份、保守门禁、失败回退、仅配置修改 | 113 项工具通过，其中恢复 18 项/包组合 7 项；现场环境收集通过后在软链接预检停止 | 高 | 未直接访问服务器；新脚本完整恢复待验收 |
| 构建与安装包 | 本机通过 | 目标 Harness 重做验收 | 重复输出一致；实际安装包与宿主组合通过 | 10 包/70 输出一致；真实安装组合、HTTP/权限/恢复烟测通过 | 中 | 不读取用户 overlays，不启动完整 DSH |
| 服务器恢复与数据完整性 | 等待执行/输出 | 启动 DSH，核对原会话、工作区、内容 | 持续运行、无新重复 ID、原资料可见 | 尚无本次恢复后服务器证据 | 高 | PKW 重新启用另行验收；配置备份不是资料冷备 |

本轮保留并合并远端 `cfbd768`（unknown CREATE 保持不确定状态）及 `6fdd3d4`（验收器兼容/回退失败证据），没有 force push。最终合并状态的全仓、类型、重复构建和安装包验证重新执行；历史修复见 [同步恢复交接](SYNC_RECOVERY_FIX.md)。

证据在本机忽略目录 `.pkw-evidence/host-merged-final-*`、`base-host-*`、`recovery-env-preflight.log`、`recovery-symlink-tooling.log`。包验证首次被本机 npm 缓存写权限限制、工具回归首次被 loopback 监听限制阻断；使用私有临时缓存和获准的本机测试环境后全部通过，未弱化业务断言或测试门禁。

本机验证使用合成数据，不代表服务器已恢复。服务器服务启动、原会话/工作区、真实内容和 PKW 重新启用的验收必须逐项提供证据。
