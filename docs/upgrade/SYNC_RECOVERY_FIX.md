# CREATE 结果未知与部署回滚诊断交接

2026-10-04，基于 `be0a4741a85b3cdabd8d1ad750283ecf81cee64d`。
保留此前登录期限、过期页返回及附件替换修复。不改数据库 schema，
不访问或修改生产，不重建身份库、空间、同步映射，不重置密码。

## A：延迟可见时重复创建——已复现并修复

旧实现有两个问题：unknown CREATE 不遵守 `nextRetryAt`；空列表超过
`recoveryGraceAttempts` 后即重新 CREATE。空列表不是“远端未提交”的证据。

确定性回归控制 interval 和 Date，HTTP、SQLite、文件系统及请求超时仍真实。
保持对象隐藏超过五次恢复检查，旧代码必然创建第二个对象；截止时间前驱动
两次 drain，旧代码也会额外查询。修复前断言失败，修复后通过。原有真实
定时器 delayed visibility 测试仍保留，未扩大窗口或放宽断言。

现在 unknown / 遗留 running intent 保持原 operationId，遵守持久重试截止时间，
按封顶退避继续只读恢复；次数耗尽不授权重新 CREATE。只有明确 known rejection
（如 429）才可在宽限后重试。恢复按**原 intent 的内容指纹**认领；期间本地编辑
保持 dirty，在认领后更新同一个远端对象。卸载重开及显式 recoverNote 使用同一路径。

限制：客户端无法区分“提交后响应丢失”和“未提交就断线”。后者也保留 unknown，
不会用自动重造换取表面完成；需要远端确定证据或服务端幂等契约才能安全裁定。
不清除 pending intent 来强制重试，不自动删除既有重复对象。本地保存继续可用，
unknown 不算远端同步成功。真实 WeKnora 行为仍需目标环境验收。

## B：服务器根因待补证，回滚诊断已完善

本机未修改的 be0a474 上，原 deployment.test.mjs 6 项全部通过，包括报告中的
部分安装失败回滚用例。不能仅凭外层 AggregateError 认定是文案错误，或承诺
服务器门禁已修好。

新版私有 `receipt.json.errorDetails` 保留部署及回滚错误的有界 cause 链，记录
`phase: stop / restore / start / verify / complete` 和
`profileRestored / serviceRestarted / verified` 三项事实。HTTP 返回码单独显示；
常见凭据形式脱敏，不采集响应正文、命令参数或完整堆栈。

原测试仍要求 `prior profile restored and verified`，增加恢复事实断言，失败时
输出脱敏底层 cause。新增停止、恢复文件、启动、业务探测失败及真实 HTTP 401
负面测试；任何一项失败都不能宣称已验证回滚。

`activate(options, execute, verify)` 支持注入验收器，也兼容服务器 `options.verify`
写法；两种入口冲突或值不是函数时在停服前拒绝。默认仍是严格 verifyHttp。
自定义验收器必须覆盖激活和回滚；协作入口必须用真实鉴权和空间业务检查，
不得以空函数代替，或为了通过单 profile 探测而关闭鉴权。

服务器先在隔离源码跑完整门禁。若 B 仍失败，提供测试生成的脱敏诊断和服务器
`deployment.mjs`、对应测试相对 be0a474 的 diff。保留失败证据，不重跑求绿、
不改预期文本或跳过回滚验证。

2026-10-04 服务器补证：15:16 UTC 的失败原日志被下一轮同名日志覆盖，
仅保留外层错误；干净及加本地改动的 checkout、80 轮循环及 40 轮负载测试
均未复现（以上为服务器回报，本机未独立执行）。14.1 秒耗时与 HTTP 重试
等待吻合，但不能由此确定子错误。B 继续标记“发生过、根因未证实”。

不得在 `catch (rollbackError)` 的消息里加上 `prior profile restored and verified`。
那会把失败伪装成成功，并让旧测试的正则误通过；使用该改法的长循环不能以
“零失败”证明恢复正常。保留 AggregateError 的两个子错误，通过本交付的
`deploymentErrorDetails` 输出，原成功断言保持不变。

每次门禁使用独立日志，成功和失败都保留退出码，首次失败即保全现场。例如：

```sh
(
mkdir -p reports
gate_log=$(mktemp "$PWD/reports/gate-XXXXXX.log")
gate_exit=0
pnpm test >"$gate_log" 2>&1 || gate_exit=$?
printf '%s\n' "$gate_exit" >"$gate_log.exit"
printf 'gate exit=%s; log=%s\n' "$gate_exit" "$gate_log"
exit "$gate_exit"
)
# 门禁非 0 时停止本次部署，不因后续重跑通过而删除首次失败证据。
```

## C、D 与部署顺序

1. 保全服务器未提交改动，尤其临时 loopback registry、验收器注入、数据格式
   转换器和既有测试补丁；在独立 checkout 对照本交付审查，不 reset/clean，
   不手改生产 lib。当前身份、空间和数据都保留。
2. 发布源必须具备受控发布与安装能力；ping/匿名读取/whoami 不等于发布权限。
   `PKW_LOCAL_REGISTRY=1` 是服务器自定义开关，官方 CLI 尚不支持，不能仅凭
   环境变量假定临时源已启用。不能以匿名发布或关闭认证绕过发布失败。
3. 用服务器实际 Harness 运行 frozen 安装、typecheck、完整 test、verify:build、
   verify:packed；成功后以全新不可变版本准备候选。pack-check 包不得上生产。
4. 现有协作系统只升级兼容代码，保全根内/根外配置、身份与内容；停写冷备并
   验证恢复，不重新 bootstrap 或用迁移前快照覆盖现有资料。
5. 所有者有效凭据仅通过安全输入或受保护服务器文件提供，不发聊天、写 Git
   或打印日志；不擅自离线重置、撤销会话。凭据缺失时线上登录验收记“未验证”。
6. 部署后核对实际版本、配置/身份/数据保留、12 小时与 30 天期限、过期跳转、
   重登原空间、附件替换、真实 WeKnora。写测试用专门样例。失败时按已验证
   流程回退，先保全新版写入，不以旧备份覆盖新资料。

## 本机验证与边界

- CREATE 修复交付时，534 项业务测试、85 项工具测试通过；5 项真实 WeKnora
  测试缺环境跳过。本次仅补验收器兼容与交接，完整工具测试增至 88 项且通过；
  业务源码未再修改，未重复运行业务、构建及安装包检查。
- 类型检查、10 包 70 输出重复构建、陈旧输出清除通过。
- 十个 tarball 在无 PKW 源码 profile 安装，导入/声明、HTTP、登录期限、
  过期页、权限隔离及运维恢复检查通过；本轮未重做浏览器手动验收。
- 本机 Node 24.15.0 / pnpm 11.7.0、Harness 0.1.5-rc.2，不替代服务器门禁。
- 没有服务器 A/B 验收、实际 WeKnora 或生产部署证据。GitHub CI 需逐 job
  核对，Harness job 跳过不能算完整 CI 通过。
