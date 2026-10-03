# PKW 个人空间与团队共享空间：实现与验收

更新：2026-10-02。**多人身份、空间隔离、角色、邀请和显式复制已有源码及本机专项证据；目标服务器尚未据此完成上线验收。** 最终整合测试、安装包、浏览器、CI 与生产结果以 [UPGRADE_DELIVERY.md](UPGRADE_DELIVERY.md) 为准。本页不沿用早期“仅研究、未实现”的结论，也不把本机通过写成生产可用。

用户已确认：首批约 **15 人**；每人私人空间，另建团队共享空间；**旧资料全部先归本人私人空间**；现有入口为 `https://ddmind.duckdns.org/pkw`。网址已知不代表服务器版本、目录、备份或当前匿名访问状态已经核验。不再要求用户重选这些已确认事项。

## 日常使用及范围

登录后选择自己的私人空间或已加入的团队。团队 owner/admin 不因此获得其他人的私人空间权限。私人内容要给团队使用时，先预览“复制笔记到团队”的正文、元数据、实际引用附件及目标，再确认创建独立副本；来源不删除，以后修改原稿不会自动更新副本。首版没有匿名公开链接、逐段权限、跨空间实时引用或协同光标。

这是应用内隔离，不是端到端加密。拥有服务器文件和备份权限的运维人员仍可能接触资料；已被合法下载的副本无法靠撤权追回。viewer 可以阅读与下载，“只读”不代表防复制。

## 实际实现与证据

源码行号是本次定位，后续以函数名和最终提交为准。

| 方面 | 当前实现 | 已有证据与剩余边界 | 源码依据 |
| --- | --- | --- | --- |
| 登录与恢复 | 本地 identity SQLite、真实 scrypt、服务端会话；改密或离线恢复撤销该账号全部会话，无公共恢复 action | identity 测试使用真实 SQLite/scrypt；离线恢复专项验证相同账号 ID、角色、旧会话失效及既有文件保持；生产恢复未执行 | `web/src/collaboration/identity.ts:49`、`:174`；`scripts/recover-account.mjs` |
| HTTP 授权 | session、管理入口、空间 RPC、页面与附件均经 gateway；未知 RPC 默认拒绝 | 真实 HTTP 与受控 startup/body 等待测试覆盖匿名、跨空间、CSRF、撤权与会话失效；目标反向代理仍待验 | `web/src/collaboration/index.ts:48`；`policy.ts:22` |
| 空间运行时 | 每空间独立 Context、state SQLite、canonical 目录、服务与 worker；内部 runtime 不开 socket | 真实三空间集成、同名文件、跨 ID 与附件访问测试；单 gateway 排他锁；不是多实例分布式部署 | `web/src/collaboration/runtime.ts:19`；`collaboration.spec.ts` |
| 操作身份 | HTTP 调用以验证后的账号作为事件 actor；管理审计按空间授权 | 基础成功操作/成员审计；不能宣称所有失败、下载、请求关联与完整审计平台均已覆盖 | `events/src/index.ts:withRequestActor`；`identity.ts:auditLog` |
| 内容冲突 | Note 与 Task 内容保存有哈希条件；冲突保留草稿并提供恢复 | 服务及 UI 定向测试；真实安装包、多窗口浏览器完成范围由协调者登记；不承诺实时合并 | `web/src/index.ts:saveNote/saveNoteBody/updateTask`；`ui.ts:saveNote/showTaskDetail` |
| 搜索 | 当前空间、独立 KB；未配置或远程主查询不可用时显式本地关键词；Processing 异常带标志 | 本机行为回归已有；真实解析、索引与质量未验。关键词只查笔记正文、附件文件名 | `web/src/index.ts:797`；`weknora-sync/src/index.ts:searchWithTrace`；[检索验收](RETRIEVAL_ACCEPTANCE.md) |
| 附件 | 授权后按本空间 AttachmentId 取字节；危险 MIME 下载、nosniff/no-store、受限 CSP | 本机 HTTP 有原字节与响应头检查；不是杀毒或对已下载文件的撤回能力 | `web/src/index.ts:serveAttachment`；`collaboration.spec.ts` |
| 显式复制 | 本人 private → 可写 team；10 分钟预览、双方权限/会话复验、源内容及实际字节校验、新业务 ID | sharing 测试有真实双空间与故障注入；界面/HTTP 接线最终验收另计；部分失败需 receipt 核对，不盲重放 | `web/src/collaboration/sharing.ts:94`；`portal-ui.ts` |
| 旧资料保全 | 单空间保全、明确 owner 的空私人空间导入、协作整根冷备/新根恢复 gate 均已实现 | 开发团队已报告工具与真实 Harness 恢复专项通过；仅受控本地数据，真实服务器仍待验 | `scripts/pkw-data.mjs`、`adopt-private-space.mjs`、`collaboration-backup.mjs`；[迁移说明](DATA_MIGRATION.md) |

## 当前角色与操作

角色只绑定一个空间。同一人可为私人 owner、团队 A 的 admin、团队 B 的 viewer。所有已登录账号可以新建自己的团队。下表依据当前服务端策略；浏览器隐藏按钮只是辅助，不能代替授权。

| 操作 | owner | admin | editor | viewer |
| --- | --- | --- | --- | --- |
| 阅读/搜索本空间、下载附件、复制可读正文 | 允许 | 允许 | 允许 | 允许 |
| 创建/编辑 Note、上传附件、管理 Task、整理目录 | 允许 | 允许 | 允许 | 拒绝 |
| 单项/文件夹软删除、批量恢复 | 允许 | 允许 | 允许 | 拒绝 |
| 永久清理回收站；全局同步/reconcile 管理动作 | 允许 | 允许 | 拒绝 | 拒绝 |
| 邀请、移除或调整 editor/viewer | 允许 | 允许 | 拒绝 | 拒绝 |
| 授予或撤销 admin | 允许 | 拒绝 | 拒绝 | 拒绝 |
| 转让 owner 给现有成员 | 允许，原 owner 变 admin | 拒绝 | 拒绝 | 拒绝 |
| 私人空间邀请其他人；直接删除最后 owner | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| 查看团队成员与管理审计 | 允许 | 允许 | 拒绝 | 拒绝 |
| 从本人的私人空间复制到此团队 | 允许 | 允许 | 允许 | 拒绝 |
| 整空间用户导出、删除空间、匿名公开链接、在线修改模型/凭据 | 尚未提供 | 尚未提供 | 尚未提供 | 尚未提供 |

邀请是 **24 小时有效、一次性的随机 bearer 链接**，不是绑定邮箱或实名收件人的邀请。拿到链接的人可按其指定角色加入；UI 明示仅发给希望邀请的人。接受、过期、撤销、邀请者降权及 scrypt 期间变化均重验；邀请不会把私人资料变为团队资料。管理员不能邀请 admin，不能管理 owner 或其他 admin。转让后旧邀请失效，始终保留一个 owner。

## 入口与隔离部署

推荐 [serve-collaboration.mjs](../../scripts/serve-collaboration.mjs) 独立进程，仅监听 `127.0.0.1`，由 HTTPS 反向代理把 `/pkw` 转入；`/healthz` 只说明进程可响应，不代表数据与权限验收通过。这样不把 Harness 的其他应用/RPC 路由一并暴露给团队。精确 publicOrigin、Host、Origin 和会话 CSRF 校验必须与代理一致；生产使用 Secure/HttpOnly/SameSite Cookie。

每个空间的固定领域表名被独立 Context/数据库隔开，不依靠请求体 workspaceId 过滤。前端伪造 actor、workspaceId 或空间 ID 不能改写已授权运行时。Note/Attachment/Task 保持原 canonical；身份库只保存账号、空间、成员、邀请、会话和审计。

**切换时必须移除旧匿名 PKW 入口。** Host 路由注册冲突会使插件失败，但旧插件先加载时不保证整个服务器自动关闭。部署必须检查旧 `/pkw/api`、旧附件路径及 Harness 其他路由不能绕过新 gateway；不能以“新插件报重复路由”代替停用旧入口。单 gateway/共享根排他锁是当前边界，不能启动两个写入者后宣称已有分布式锁。

## 检索、复制与失败边界

每空间配置独立远端 KB，gateway 拒绝同一规范化地址/KB 被多个空间复用；部署方还须检查不同地址别名是否实际指向同一投影。业务检索继续 Main/Processing → Business 聚合与 active canonical 过滤，remote ID 不成为授权依据。没有真实 WeKnora 样本前，不能由目录隔离测试推导远端链路与解析质量全部通过。

RPC 的 `mode=local-keyword` 限制为当前空间笔记正文和附件文件名，不包含附件内部全文或语义；`mode=remote` 且 `trace.processingUnavailable=true` 表示远程结果不完整。界面保留范围提示，评测记录模式、partial 比例及未知旧证据。空结果不证明未被检索的附件里没有答案。

复制预览包含正文、frontmatter、引用附件清单和目标范围；来源 SHA/附件真实字节变化会拒绝原确认。常规 Markdown 图片/文件链接会重建引用，其他私人笔记、Task、目录和历史不连带复制。无法可靠枚举的附件格式明确拒绝，不静默丢附件。当前单次上限：正文 1 MiB、40 个附件、每个 16 MiB、合计 32 MiB；限制不是 15 人容量承诺。

复制 receipt 存在私有 shares 目录，仅记录身份、哈希与进度，不存原文或凭据。每个副作用前落盘；重复确认成功记录返回同一结果。上传/建笔记确认丢失或中断时标记/解释为 needs_review，返回记录编号、唯一路径与已确认 ID，避免自动产生重复附件；管理员核对后决定保留或移入回收站。这不是跨 SQLite/文件的原子事务，也不会自动 purge 团队资料。

## 迁移、账号恢复与发布门槛

旧资料先完整保全到经指纹绑定的备份，再在**本人空私人空间**副本演练；ID、正文、二进制、Task 关系、回收站与事件对账，团队从空开始。未知格式、引用不一致或校验失败时停止，不猜 owner、不公开、不覆盖旧根。正式切换需停写及排他维护；回滚先保全切换后新写入和最新权限，不能直接恢复旧快照丢内容、恢复失效会话或重新开放撤销成员。

账号遗失使用离线运维恢复工具；无公共 resetPassword 接口。恢复只改该账号密码并撤销其全部旧会话，不重建用户、空间或角色。恢复后的账号与其他成员仍须在目标副本验权；如何停止服务和保管新密码属于目标环境流程。

协作整根冷备工具 `scripts/collaboration-backup.mjs` 的 backup/verify/verify-source/restore/approve-recovery 已实现；开发团队已报告工具及真实 Harness 整根恢复专项通过。恢复到全新根，逐空间保持 workspaceId 并重定位 registry.path，撤销旧 sessions/invitations，生成 recovery-pending.json 阻止直接启动；离线核对成员权限、文件与 schema/引用门槛后才批准移除 gate。测试包括已有空间和未初始化空间、gate拒绝/批准及恢复后权限内容读取。它不是目标服务器已备份/恢复的证据；不能以恢复旧身份文件重新激活已撤销访问。

| Task | Status | Next step | Completion standard | Verification evidence | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| C0 产品范围与归属 | 已确认 | 保持约 15 人、旧资料本人私有 | 不自动扩大共享范围 | 用户确认、本文 | 中 | ddmind 已知不等于服务器已验 |
| C1 身份、会话、角色 | 源码已实现；本机专项已验证 | 最终包/浏览器与生产代理复验 | 正向可用；匿名/过期/伪 CSRF/未知动作拒绝；改密/恢复撤销会话 | identity/security/HTTP 集成测试 | 高 | 总数由协调者统计 |
| C2 独立空间与对象授权 | 源码已实现；真实本机多空间集成已验证 | 安装包及部署副本验证 | 私人相互不可见，附件/搜索/Task/事件不串空间，撤权后新请求拒绝 | collaboration/migration 测试 | 高 | 尚非生产或多实例容量证据 |
| C3 邀请、成员与复制 | 源码已实现；局部流程和故障专项已验证 | 门户浏览器闭环及凭据过期/撤权 | 邀请一次性；正确空间/角色；预览准确、原件保留、重试不重复 | sharing/portal/安全测试；浏览器另记 | 高 | 不含公开分享或整空间用户导出 |
| C4 旧数据导入 | 工具与本机运行时演练已实现；生产待验 | 收集目标存储/配置/手改补丁与停写方式 | 原件/备份对账后导入本人空间，其他账号拒绝访问 | DATA_MIGRATION、迁移测试及目标 receipt | 高 | synthetic 数据不是服务器备份 |
| C5 协作全根备份恢复 | 已实现；开发团队报告工具及真实Harness恢复gate专项通过 | 对目标备份进行独立新根恢复和成员复核 | 不覆盖旧根、旧会话/邀请失效；审批前拒启动；runtime权限及内容对账 | DATA_MIGRATION、工具/迁移集成；目标待验 | 高 | 单空间 pkw-data 不能代替 |
| C6 约 15 人试用与真实检索 | 15合成账号本地HTTP功能并发已过；目标/真实质量待验 | 真实问题/金标准、代表性负载、手机真机 | 质量/时延/容量与设备证据可复核，退化可见 | collaboration.spec.ts的30写/45读；真实报告另验 | 高 | 本地功能用例不承诺生产吞吐/质量 |

完整 CI 的 verify job 仍受 HARNESS_REPO_URL、HARNESS_REPO_TOKEN、HARNESS_REF 和实际运行状态门禁约束；只看到 repo/tooling 绿色不能宣称 Harness、安装包与集成 CI 全通过。目标服务器与真实语料仍需部署方提供并实际核验，不再要求用户重复解释已定产品模式。

具体配置、独立loopback启动、反向代理、旧资料导入与离线账号恢复步骤见 [COLLABORATION_DEPLOYMENT.md](COLLABORATION_DEPLOYMENT.md)。该指引是部署交接，不是已经在ddmind执行的日志。

设计依据沿用本轮一手研究：[OWASP 授权](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)、[多租户安全](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)、[会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)、[授权回归](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Regression_Testing_Cheat_Sheet.html)。引用说明设计原则，不代替工程与生产证据。
