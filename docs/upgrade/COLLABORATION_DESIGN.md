# PKW 个人空间与团队共享空间方案

日期：2026-10-02。状态：**产品与技术设计，尚未实现多人鉴权或空间隔离，不能据此开放多人生产使用。**

用户已确认：既要个人使用，也要多人使用；采用“每人有私人空间，另建团队共享空间”。本方案按这个决定展开，不再要求用户重选。现有可靠性修复继续推进；多人能力作为单独的实施阶段，有自己的验收门槛。

## 用户会怎样使用

登录后看到“我的空间”和自己加入的团队。私人笔记默认只有本人可访问；团队管理员的身份只在对应团队生效，不自动获得别人的私人空间权限。团队共享资料由该团队成员按角色使用；退出或被移除后，后续请求不再获得团队内容。

例如，你先在私人空间写一份方案，决定给同事看时选择“复制到团队”，确认正文、附件和引用范围后产生团队内独立资料。原私人笔记仍保留；修改私人原稿不会悄悄更新团队副本。首版不做匿名公开链接、跨空间实时引用或文档逐段权限，先把空间边界做完整。已经被合法下载或手工复制的内容无法通过撤权追回，界面不会承诺这种能力。

这是一种应用内权限隔离，不是对服务器运维人员的端到端加密承诺。拥有服务器文件和备份权限的人仍可能接触内容；运维访问、备份恢复权限和审计应单独管理，不能伪装成普通团队管理员功能。

## 实际现状与缺口

以下来自本轮工作区源码；行号用于定位，最终以函数名与提交为准。宿主检查使用本机 Harness `0.1.5-rc.2` 源码目录，尚未证明与生产版本相同。

| 方面 | 当前已有 | 多人使用缺什么 | 源码依据 |
| --- | --- | --- | --- |
| 工作区 | `workspaceRegistry` 与 `WorkspaceId` 已有；文件句柄会检查路径包含关系 | `PkwWebService` 每个实例固定一个 workspacePath 和服务集合，没有请求级成员上下文或空间切换 | `packages/pkw/web/src/index.ts:244–303`；`workspace/src/index.ts:58–103` |
| HTTP 入口 | `/pkw` 页面、`/pkw/api` RPC、附件字节/预览路径 | PKW handler 未取得登录身份，未按角色/空间/对象授权；有登录代理也不能代替资源权限 | `web/src/index.ts:306–344`、`:419–438` |
| 本机宿主 | WebServer 按路径匹配并调用 handler | 所检宿主这段分发链没有统一身份中间件；生产反向代理和网络入口未核验，不能推断线上是否匿名可达 | 本机 Harness `packages/host/webserver/src/index.ts:220–236` |
| 本地存储 | Note Markdown、附件二进制和 Task Store 保持各自 canonical；部分记录含 workspaceId | domain 名固定，部分键/列表没有空间过滤；单加 workspaceId 参数或重复挂载插件不能证明隔离 | `domain/src/spec.ts:117–139`、`:191–198`；`notes/src/index.ts:115–122`；`tasks/src/index.ts:listTasks` |
| 检索 | 当前工作区的 Main/Processing → Business 聚合、active canonical 过滤 | 没有按登录成员选择可查空间；投影、缓存、后台任务和结果都需空间绑定 | `web/src/index.ts:listKnowledge/enrichRetrievalResults`；`weknora-sync/src/index.ts:searchWithTrace` |
| 附件 | 按 AttachmentId 查原文件，支持预览/下载；本轮已加受控inline类型、危险类型下载、nosniff/no-store及受限CSP | ID 不是权限；字节、预览、缓存均需成员授权；MIME加固不代表租户隔离或完整内容安全 | `web/src/index.ts:serveAttachment`，约346行；本轮Web50项通过，实际安装包验证另计 |
| 审计 | Durable Event Log 已有 workspaceId、actor、operationId | 一般用户操作仍写 `{type:'user'}`，未绑定可验证的具体成员；需记录授权主体及策略结果 | `domain/src/types.ts:33–45`；`tasks/src/index.ts:110–118`；`events/src/index.ts:97–107` |
| 并发编辑 | Note 条件保存与冲突保稿本轮已实现 | 这是内容版本保护，不是身份鉴权；Task 仍无多人版本冲突协议，外部写入仍有独立风险 | `web/src/index.ts:noteWriteOptions/saveNoteBody`；[DEBT O13](../DEBT.md) |

因此，“能从两台电脑打开页面”不等于“多人隔离与权限已完成”。本轮仅研究，不偷偷修改现有 schema 或把历史资料分配给假设出来的成员。

## 首版角色与操作建议

角色绑定到**一个空间的成员关系**，不是全局头衔。同一人可以是私人空间所有者、团队 A 管理员、团队 B 只读成员。私人空间不开放团队邀请；需要协作时显式复制到团队。

下表是建议的默认权限；不是当前代码已支持。所有者（owner）负责空间归属，管理员（admin）负责成员和维护，编辑者（editor）负责内容，只读成员（viewer）负责阅读。团队共享内容允许编辑者修改他人创建的内容，因此历史与冲突保护必须可用。

| 操作 | owner | admin | editor | viewer |
| --- | --- | --- | --- | --- |
| 阅读、搜索本空间内容；查看原附件 | 允许 | 允许 | 允许 | 允许 |
| 下载单个可读文件、复制可读正文 | 允许 | 允许 | 允许 | 允许；只读不等于防复制 |
| 创建/编辑笔记、上传附件、管理任务 | 允许 | 允许 | 允许 | 禁止 |
| 移动/重命名本空间内容 | 允许 | 允许 | 允许 | 禁止 |
| 将单项内容移入回收站、恢复内容 | 允许 | 允许 | 允许 | 禁止 |
| 整文件夹/批量删除 | 允许，预览范围 | 允许，预览范围 | 首版禁止 | 禁止 |
| 永久清除回收资料 | 允许，二次确认 | 允许，二次确认 | 禁止 | 禁止 |
| 导出整个空间 | 允许，审计 | 允许，审计 | 首版禁止 | 禁止 |
| 邀请/移除 editor、viewer，调整这两种角色 | 允许 | 允许；不能给自己提权 | 禁止 | 禁止 |
| 授予/撤销 admin | 允许 | 禁止 | 禁止 | 禁止 |
| 转移 owner、删除空间 | 允许，重新验证身份；不得无 owner | 禁止 | 禁止 | 禁止 |
| 修改团队索引/模型配置、触发重建 | 允许 | 允许；不返回凭据值 | 禁止 | 禁止 |
| 查看空间成员及操作历史 | 允许 | 允许 | 内容历史可见，成员管理细节受限 | 只读内容历史；敏感管理事件受限 |
| 复制到另一个空间 | 源空间可读且目标可写，单独授权与预览 | 同左 | 同左 | 源可读且目标可写时才允许 |
| 生成匿名公开分享链接 | 首版不提供 | 首版不提供 | 首版不提供 | 首版不提供 |

移除成员与角色降级对**下一次请求及尚未执行的导出任务**生效，不能依赖旧页面按钮是否隐藏。邀请建议使用有期限、一次性、绑定目标身份的邀请记录；接受邀请不自动加入其他空间，普通管理员不能绕过 owner 规则。

角色矩阵只是易懂的操作清单；最终判断还要同时检查当前成员关系、资源所属空间和操作类型。默认拒绝、每次请求验证、在服务端统一执行，是本方案采用的授权原则。[OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)

## 服务端与存储边界

建议请求链路为：验证登录身份 → 读取所选空间 → 验证有效成员关系 → 建立不可由请求体改写的 RequestContext → 按操作策略授权 → 查资源并确认所属空间 → 执行领域操作与审计。

RequestContext 至少携带 `principalId`、`workspaceId`、角色/成员版本、`requestId` 和已验证的认证来源。前端传来的 workspaceId 只用于选择空间；不能当成授权证明。不要在全局可变的“当前空间”字段里切换，以免两个请求交错时串空间。此处是 PKW 的设计选择；请求级空间上下文、对象授权与后台上下文传播参考 OWASP 多租户指南。[OWASP Multi Tenant Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)

每个 RPC 都必须登记 action，新增但未登记的 RPC 默认拒绝。NoteId/AttachmentId/TaskId 继续稳定，但查对象时必须同时处在已授权空间；拒绝请求不返回其他空间的名称、正文、对象数量、绝对路径或存在性细节。附件 URL、preview、download、导出文件和后台管理入口同样执行授权，不能只保护 `/pkw/api`。

**第一版建议按空间隔离 canonical 目录与结构化存储作用域。** 不直接把多套 Notes/Tasks 服务挂到同一个全局 provider。先用两个个人空间与一个团队空间的测试样本，证明 storageDomain、服务引用、事件、缓存和 worker 均隔离；若宿主不能安全提供独立作用域，则采用每空间独立运行单元，由统一入口验证身份并路由，内部请求仍验证可信主体和授权上下文。隔离单元的端口不能绕过统一入口直接公开。是否同进程以实际 Harness 能力验证决定，不先承诺“一行配置支持多人”。

可新增成员、邀请、会话和策略存储，作为权限事实来源；不得把 Note 正文、Attachment 二进制或 Task 当前状态另存为一套新 canonical。后续若采用共享表，所有查找、唯一键、引用、分页、批量操作、回收站、事件、修复扫描都要携带空间范围，并有迁移方案。不能只补列表的 WHERE 条件。

## 检索、附件与后台处理

以下是针对 PKW 现有 A2 聚合和文件服务制定的实施要求，并非宣称 WeKnora 已提供这些权限：

- 首版默认只搜当前空间。“全部可访问空间”作为后续可选功能，由服务端枚举有效成员空间后分别检索，再合并；前端不能任意指定 KB 列表。
- 每空间绑定独立的 Main/Processing 投影集合与凭据作用域。WeKnora 仍是派生索引；不能把 KB 名称或 remote ID 当作权限或业务身份。
- 检索召回、重排、摘要、关联图、来源/片段展示都验证空间归属及 active canonical；越权片段不能先送入模型或日志，再在 UI 隐藏。投影更新延迟时仍由本地授权边界拒绝访问。
- 私人 Note 中的附件不会因为复制笔记到团队而自动全部开放。复制预览列出正文、要复制的二进制与引用；创建目标对象使用新的业务 ID，记录来源关系。原对象的移动/重命名仍保持原 ID。未获授权的引用拒绝复制或明确移除，不能留下可取回私人内容的 URL。
- 任务 sourceRefs、Wiki/relatedKnowledge、附件 owners 和 Companion Note 都遵循同空间原则；任何跨空间关联必须经过显式分享设计，不默默追溯到私有源。
- 动态响应与导出缓存按空间、身份/权限版本区分；注销、撤权、切空间时清理客户端缓存和未完成读取。首版敏感字节可采用 `private, no-store`，后续缓存优化必须单独验撤权边界。
- 上传 HTML/SVG 等可执行内容不在主应用源直接 inline 运行。本轮已将受控常用图片/PDF及TXT预览之外的类型保持下载，并补nosniff/no-store/受限CSP；这是有限响应加固。上传MIME来自用户，完整内容验证、隔离预览源以及共享Markdown的原始HTML/URL/扩展仍需多人阶段验收；HttpOnly不能替代内容隔离。[OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)、[MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)、[MDN nosniff](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Content-Type-Options)
- worker 的 intent、重试、reconcile、摘要、远端删除必须绑定空间，并以限权系统主体执行；导出等代表用户的延迟任务在执行/交付前复验当前授权。不同空间的相同文件名、同正文和缓存 key 不可混淆。

这些要求保留“服务端本地读写不依赖 WeKnora”；认证与本地权限存储可用时，WeKnora 停止仍能管理本空间资料。它仍不承诺浏览器与 PKW 断网后的离线编辑。

## 身份、会话与请求保护

优先复用经过验证的宿主身份提供方或成熟登录组件。若通过反向代理接收身份，只信任受控代理传来的、可验证的主体；删除客户端伪造身份头，阻断绕过代理的入口。不要把现有 WeKnora API key 或 GitHub token 当用户登录凭据。此轮不预选收费服务或自建密码系统。

建议浏览器使用服务端会话与 `Secure`、`HttpOnly`、明确 `SameSite` 的 Cookie；登录、权限提升、身份恢复后更新会话，注销及管理员撤销可使会话失效，设置闲置与绝对超时。会话标识不包含角色和私人数据，也不写进 URL。这部分采用 OWASP 会话管理建议。[OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

写操作限定合适的 HTTP 方法与 JSON 类型，使用会话绑定的 CSRF token，并校验受信任 Origin；严格配置 CORS，不将通配来源与凭据请求组合。SameSite 是补充层，不能据此省略 CSRF 设计；JSON 字符串和“浏览器报跨域”也不代表服务器没有执行写操作。[OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)

审计记录主体、空间、动作、对象 ID、结果、时间、关联请求和关键角色变更。不要记录密码、会话 token、原文或全部附件；管理员日志也按空间授权。团队邀请、撤权、导出和永久清除须可追溯。基础限速、上传/导出大小、每空间工作队列与总资源上限，防止一个空间占满其他人的服务。

## 迁移与回退

1. 先确认真实目标宿主、入口鉴权、现有资料所有者、结构化存储位置、UI 手改补丁及 WeKnora 投影绑定；通过 GitHub 交接脱敏信息，不要求用户贴凭据。
2. 对现有工作区默认建立**明确指定所有者的私人空间**，不能自动变成全员共享。保留其 NoteId、AttachmentId、TaskId、正文、二进制、Task 关系及事件；新团队空间从空开始。
3. 先在副本演练，记录文件哈希、对象/事件数量、引用关系、权限清单和索引归属。旧单空间数据缺少权限事实时停止迁移并报告，不能猜所有者或默认公开。
4. 正式切换采用维护窗口/一致性快照；新旧版本不可同时对同一 canonical/结构化存储写入。迁移器必须可重复检测，验证失败不切流量。
5. 多人开启后，旧版无鉴权页面不允许直接重新对外开放。回退先封闭/停写、保留切换后的新写入与权限数据，再决定回到隔离旧版或向前修复。恢复旧备份不能无声丢弃新内容或重新开放已撤销成员。
6. WeKnora 可按空间重建投影，但不能以“重建索引”为由删除 canonical；远端清理只针对确认归属的投影。整个阶段不执行历史 OPTION A 转换，除非另有独立验收范围。

## 分期交付与多人验收

| Task | Status | Next step | Completion standard | Verification evidence | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| C0 确认私人 + 团队模型 | 已完成：用户确认；角色表为建议设计 | 与团队规模、真实部署身份链核对 | 私人默认不共享，团队角色只在对应空间生效 | 本文及会话确认 | 中 | 不再重复询问已定方向 |
| C1 身份与服务端授权骨架 | 未实施 | 确认宿主身份接口，建立 RequestContext 和 action 清单 | 所有 RPC/附件/导出先认证授权；未知动作默认拒绝 | 匿名、过期、伪造主体、角色不足的 HTTP 负例 | 高 | 仅隐藏按钮不通过 |
| C2 双私人 + 团队隔离垂直验证 | 未实施 | 测试环境建立 A 私人、B 私人、团队 T | 目录、结构化存储、事件、缓存、worker、检索无串空间 | 三空间同名/同正文/跨 ID/交错请求和重启测试 | 高 | 先验证服务作用域，后迁移生产 |
| C3 成员与内容流程 | 未实施 | 邀请、接受、降级、移除、复制、导出、回收站 | 角色表每格允许/拒绝明确；撤权下一请求生效；失败不泄露内容 | 角色 × 操作 × 空间的自动化权限矩阵和真实浏览器 | 高 | 不含匿名共享、协同光标、实时合并 |
| C4 旧数据演练与有限试用 | 待目标信息；不阻断本轮个人版修复 | 副本迁移、备份恢复，指定少量成员试用 | 身份/内容/附件/任务对账通过；复原不丢新写入、不复活权限 | 迁移及回退报告、目标宿主集成和人工场景记录 | 高 | 测试通过才开启多人入口 |
| C5 扩容与更细分享 | 后续候选 | 用真实团队与数据规模排序 | 查询延迟、资源公平性及成本有基线；新分享规则有负例 | 规模/质量评测，权限回归持续运行 | 中 | 不承诺人数或吞吐量，未测前不报指标 |

多人测试必须包含 A 访问 B 私人空间、viewer 直接调用写 API、猜 AttachmentId、旧预览链接、搜索/摘要/关联图泄漏、成员撤销、缓存命中与备份恢复等负例，并进入 CI 的必跑门禁。采用“主体—资源—动作”的测试矩阵，正向能用和反向确实被拒绝都要验。[OWASP Authorization Regression Testing Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Regression_Testing_Cheat_Sheet.html)

当前可对用户承诺的是：已有个人产品的可靠性升级源码与本机自动化已通过；最终安装包/浏览器及发布由协调者收尾；私人 + 团队方案已形成。登录、成员、权限隔离、迁移与多人上线仍未完成，不能由本轮354项Vitest、7项工具测试或双窗口冲突测试推导出来；5项真实WeKnora集成仍跳过。
