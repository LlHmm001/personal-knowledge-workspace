# 旧数据保全与隔离恢复演练

本工具已实现可执行的清点、备份、校验和隔离恢复。它不会连接服务器、打开源 SQLite、改写旧数据、升级旧存储版本，或覆盖现有目标。生产地址为用户提供的 `https://ddmind.duckdns.org/pkw`，但本工具的本地测试不代表该服务器已经迁移或验收。

用户已确认：**现有全部资料先归本人私人空间**。迁移时保留原 NoteId、AttachmentId、TaskId、矩阵、事件、回收站及同步映射；不得默认进入团队空间、向其他约 15 位使用者开放，或通过重新生成 ID 来绕过引用问题。目标账号/私人空间绑定由显式导入步骤完成，本工具不发明所有者或改写 workspaceId。

## 使用边界与完成标准

| 项目 | 工具行为 | 完成标准 |
| --- | --- | --- |
| 原始文件 | 整个 workspace 和明确指定的 state 全部复制；包含空目录、Markdown、二进制、JSON、回收站、DB/WAL/SHM/journal 原件 | 原始副本文件路径、数量、大小和 SHA-256 与源快照一致 |
| SQLite | 只在临时副本打开 DB；读取其已提交 WAL，执行原生 backup，生成自包含 SQLite 副本 | `integrity_check`、`foreign_key_check` 通过；表结构、域版本、每表行数/逻辑哈希一致 |
| 身份与引用 | 检查已知记录身份、Note 文件身份/内容哈希、附件字节、Task 矩阵/父子/笔记来源、回收目录、映射与反向映射；保留事件历史 | 对账报告明确列出原有异常，既不自动删除也不“修复”成空数据 |
| 防止漏掉新写入 | 复制前后、多阶段及成功标记前再次读取源指纹；切换前必须 `verify-source` | 发现内容变化、新增/删除文件、mtime/ctime/身份变化即拒绝旧快照 |
| 目标恢复 | 只允许创建不存在的隔离目标；拒绝原路径、相互包含、符号链接父目录、已有空/非空目录 | 目标所有原始文件哈希相同；SQLite 与经过校验的自包含副本字节和逻辑均相同 |
| 真正迁移交付 | 另行使用匹配的 Harness/PKW 运行时打开实际服务器数据的目标副本，核对私人空间和业务功能 | **本工具不声称完成**；`canStartNewVersion=false`、`runtimeAcceptance=not_run` |

依赖 Node **22.16+ 或 24+**，本地实际验证版本为 **24.15.0**。SQLite 使用 Node 内置 `node:sqlite`，不依赖 Harness、npm 新依赖或 sqlite3 命令行。[Node SQLite API](https://nodejs.org/docs/latest-v22.x/api/sqlite.html#sqlitebackupsourceDb-destination-options) 记录了 `backup` 和 `setReturnArrays` 的版本边界。

`workspace` 必须是实际 PKW workspace 根目录，含 `notes/`、`attachments/`、`archive/` 等；`state` 必须明确指向实际结构化存储目录，也支持 JSON 单文件或 SQLite 单文件。指定 SQLite 文件时，工具形成显式 `sqliteBundle`：主文件及同名 `-wal`、`-shm`、`-journal` 一起清点和复制，复制期间新出现或消失的 sidecar 也会改变源指纹。这样可以安全处理 `workspace/` 与 `state.sqlite` 位于同一父目录的实际布局。

初版要求 workspace/state 两个根不重叠，且路径为 `realpath` 后的真实绝对路径。符号链接、设备、FIFO 等特殊文件会明确失败，不会偷偷跳过或复制链接目标。若目标部署布局不满足这些要求，应先根据实际配置增加专门适配并验证，不能移动生产文件来“凑”测试。Docker 容器路径、宿主机挂载路径及多个结构化库的实际范围仍需由部署清点确认。单 SQLite 文件输入只包含同名 bundle，不会静默扫描同目录其他库；如果旧系统还有其他 DB/JSON 域，必须选择包含其全部状态的目录或增加明确适配。

## 停写与备份

以下路径都是示例占位符，不是生产部署命令。不要把 JSON 报告重定向到 workspace/state 内，也不要把备份放在源目录中。

1. 确认实际 workspace、所有 state 文件以及当前运行时/域版本。先做只读清点，可在独立输出目录保存报告：

   ```sh
   node scripts/pkw-data.mjs inspect \
     --workspace /absolute/real/workspace \
     --state /absolute/real/state > /absolute/reports/inspect.json
   ```

   `inspect` 仅创建随后自动清理的本地临时副本；`reusableBackup=false`。如果源同时变化，退出码为 4，应停写后重做。清点不会运行当前 `storageDomain.open()`，因此不会触发旧库版本拒绝后误改 header。

2. 停止所有写入者并保持停写：PKW 服务、同步 worker、定时任务、其他应用、直接文件编辑和其他 DB 连接的写入。`--offline-confirmed` 是部署方对停写事实的确认，不是工具自动取得的跨进程锁。SQLite 单库 backup 的一致性不能替代整个 Markdown/附件/多个结构化库的停写窗口。

3. 创建全新备份目录。若输出目录已存在，命令会失败，连空目录也不会复用：

   ```sh
   node scripts/pkw-data.mjs backup \
     --workspace /absolute/real/workspace \
     --state /absolute/real/state \
     --output /absolute/backups/first-offline-snapshot \
     --offline-confirmed > /absolute/reports/backup.json
   ```

4. 将 `backup.json` 中的 `manifestSha256` 保存在备份目录之外，用它绑定后续操作：

   ```sh
   node scripts/pkw-data.mjs verify \
     --backup /absolute/backups/first-offline-snapshot \
     --manifest-sha256 REPLACE_WITH_64_LOWERCASE_HEX
   ```

   不提供这个参数时，工具能发现文件与清单不一致，但无法识别一个同时被完整替换的数据包和清单；它不是签名或外部信任锚。

## 恢复到隔离副本

```sh
node scripts/pkw-data.mjs restore \
  --backup /absolute/backups/first-offline-snapshot \
  --target /absolute/rehearsals/private-owner-copy \
  --manifest-sha256 REPLACE_WITH_64_LOWERCASE_HEX
```

目标此前必须不存在，父目录必须已存在。成功后包含：

- `workspace/`：所有原始工作区文件，包括回收站和空目录。
- `state/`：原始 JSON/其他文件；单 SQLite bundle 也恢复在此目录，报告 state 指向主文件；SQLite 主库替换成已经包含 WAL 提交的自包含副本，其配套旧 WAL/SHM/journal 不被混入目标运行目录。原件仍完整保存在 backup 的 `raw/state/`。
- `restore-report.json`：最终成功标记、身份/记录摘要、备份清单指纹和目标路径。

目标文件使用私有权限（目录 0700，文件 0600，受当前 umask 限制）。源 mode、mtime、ctime、文件系统身份均记录在清单，用于检测新写入；恢复不复用源 UID/GID、ACL、扩展属性、硬链接拓扑或文件系统时间。业务记录里的 createdAt/updatedAt 等字段及 Markdown 原始字节不变。如果实际部署依赖其他元数据，需要独立适配并验收。

旧 JSON v1/v2、旧 SQLite 域版本、未知格式和未知表均可保真恢复到隔离副本，但报告会列为预检阻断。**不得直接把 `pkw_notes` 的版本数字改为 3，不得把未知 schema 当作当前 schema。** 当前运行时明确定义了版本不匹配即拒绝打开；后续只能针对已经识别的实际旧 schema 写显式转换器，另留转换前副本并重新核对稳定身份、引用和每条记录。没有该转换器时状态为“已保全，尚未迁移到新运行时”。

## 清单与机器门禁

`manifest.json` 格式为 `pkw-data-preservation` / `version=1`，且必须 `status=complete`。

| 字段 | 含义 |
| --- | --- |
| `source` | 源真实绝对路径、目录/文件类型；SQLite 单文件含 sqliteBundle=true；不会推断源位置 |
| `sourceInventory` | 每个源路径的原始 SHA-256、大小、类型、mode、纳秒时间和设备/inode；目录也清点 |
| `sourceFingerprint` | 两个源清点结果的摘要，用于判断旧备份能否用于当前源的切换 |
| `payload` | 备份中每个文件/目录的清单；`verify` 拒绝缺失、篡改和多出的文件 |
| `sqlite[].path` | 原 state 中的 SQLite 路径 |
| `sqlite[].normalized` | 自包含 SQLite 副本路径，与 raw 字节分开记录 |
| `sqlite[].logicalSha256` | SQLite 结构、user_version、units 域版本、表列/行数/排序后的行摘要；保留 BLOB 和 BigInt |
| `reconciliation.identities` / `identitySha256` | Note/Attachment/Task/矩阵/回收目录/操作/事件/知识映射 ID 及摘要 |
| `reconciliation.records` / `recordsSha256` | 已可解析结构化表的完整记录摘要，未知字段也参与哈希 |
| `reconciliation.issues` | 原有数据异常、未知格式、版本不匹配、引用缺失等；不在备份过程中改写它们 |
| `reconciliation.readiness` | 静态预检状态、必须另行完成的运行时验收和私人归属要求 |

**SQLite 原文件 SHA-256 通常不等于 normalized 副本 SHA-256，这是正常的。** raw DB/WAL 按原字节逐项校验；normalized 副本有自己的文件哈希，再以 `logicalSha256` 和每表行数/摘要证明逻辑内容、版本及 schema 没变。不能把物理页布局变化当成丢记录，也不能只比较 DB 文件大小作为成功证据。

`--require-ready` 可用于 `verify`、`verify-source`、`restore`，只要求 `readiness.preflightChecksPassed=true`。其名字表示**离线预检通过**：已知版本和可检查身份/引用无阻断。它不是完整 Zod 校验、运行时迁移成功或允许公开分享的标记。`runtimeSchemaValidation`、`runtimeAcceptance` 一直为 `not_run`，`canStartNewVersion` 一直为 `false`，必须另行跑目标副本验收。

外部门禁至少绑定 `manifestSha256`，检查退出码，并核对以下条件：

- 源维持停写；正式切换前最后一次 `verify-source` 成功，之后不能恢复旧写入者再拿这份快照切换。
- 目标空间绑定当前所有者私人账号；不向任何团队成员授予旧内容访问权。
- 目标运行时/存储版本真实兼容，或已有经过验证的显式旧 schema 转换结果。
- 目标中读取笔记/二进制、任务层级/来源、回收恢复、事件、同步映射的数量、稳定 ID 与摘要对账通过；不能仅看 HTTP 200。

## 新写入、失败与回退

切换前执行：

```sh
node scripts/pkw-data.mjs verify-source \
  --backup /absolute/backups/first-offline-snapshot \
  --manifest-sha256 REPLACE_WITH_64_LOWERCASE_HEX \
  --require-ready
```

若源在备份后发生任何新增、修改、删除，退出码 4；旧备份本身可能仍通过 `verify`，但已经不能用于“保留所有最新写入”的切换。重新停写、重新备份、重新恢复和验收。不存在“校验通过后可以继续写旧库”的安全窗口。

正常异常会移除本次新建的输出/目标，原数据和既有备份不动。进程被强制杀死或机器掉电，可能留下部分目录；没有最终 `manifest.json` 或 `restore-report.json` 不算成功，不能启动。不要向其中继续叠加数据，使用新的隔离目标重新执行。写入的文件和目录会执行 fsync；这不能替代底层磁盘、挂载文件系统或平台的持久性保证。

已经开始接收新写入的目标绝不能用旧备份覆盖。本工具拒绝覆盖任何既有目录。若上线后要回退，先停目标写入并为其新增资料做独立备份/差异处理，再选择经过验证的业务回退方案。现有 deployment 的 package/node_modules 回退和本工具的数据保全是不同步骤，不代表可以回滚 canonical 数据。

## JSON 与退出码

CLI stdout 始终为一个 JSON 对象，包含 `ok` 和 `exitCode`。成功包含 `operation` 和相关报告；失败包含 `error.kind`、`message` 和有限 `details`。Node 实验性 API 警告可能写 stderr，不影响 stdout JSON。报告包含路径和稳定 ID，应留在部署方本地。

| 退出码 | kind | 意义与下一步 |
| --- | --- | --- |
| 0 | OK | 本条操作完成；仍须查看预检/运行时验收字段，不能据此宣称生产迁移完成 |
| 2 | USAGE | 参数无效、缺少停写确认或绝对路径；修正参数 |
| 3 | UNSAFE_PATH | 目标已存在、重叠或经过符号链接；选全新安全路径 |
| 4 | SOURCE_CHANGED | 源已变化；停所有写入者后重新创建完整快照 |
| 5 | INTEGRITY | 字节、清单、身份/记录摘要、SQLite 完整性等校验失败；保留源，排查后重试 |
| 6 | UNSUPPORTED | 不支持的运行时/文件类型/布局；先增加明确适配 |
| 7 | IO | 权限、磁盘、缺失路径等 I/O 失败；不算备份/恢复成功 |
| 8 | NOT_READY | 保全成功，但 `--require-ready` 遇到原有版本/引用/未知格式阻断；在副本评审并修复/显式迁移 |

## 实际验证与尚未完成项

运行：`node --test scripts/tests/data-preservation.test.mjs`。

本地测试覆盖 JSON 完整保真与空目录、真实 SQLite WAL 未 checkpoint 提交、任务/事件/回收/映射、旧 JSON v1/v2 和 SQLite v1 域、不改旧版本、未知表与 BLOB/64 位整数、未知字节文件、新增写入及同字节 ABA、切换前旧快照拒绝、损坏 SQLite/FK、篡改与恶意路径、恢复中途失败/重试、恢复 DB 被改后的拒绝、多 workspace 导入阻断，以及 CLI JSON/退出码。测试使用临时副本，不接触真实服务器或凭据。

尚未完成且不能冒充完成：实际服务器目录/挂载/存储后端识别、真实源的停写/备份、旧 schema 专用转换（若实际版本需要）、实际服务器资料的目标副本运行时验收、生产私人空间导入与所有者核对、生产切换和切换后的业务对账。本工具解决这些步骤的数据保全前提，不代替其执行证据。

## 将副本导入已有的本人私人空间

`adopt-private-space.mjs` 是在上述保全基础上实现的显式导入工具。输入必须是绑定了独立 `manifestSha256` 的完整备份，目标必须是**已注册、属于指定账号、尚未创建内容目录的私人空间**。工具不是“覆盖空间”或“合并不同用户资料”工具。

先启动协作 gateway 完成所有者账号初始化、登录确认账号和私人空间 ID，然后正常关闭 gateway。只访问登录/session/空间目录即可，**不要先进入私人空间创建其内容目录**。空间 ID 可从登录后的 session 响应/空间链接确认，格式为 `sp_` 加 32 位小写十六进制字符；使用实际的 `space.id`，不要把 username、旧 workspaceId 或团队空间 ID 代进去。账号名按 gateway 规则转换为小写。目标根必须已存在且是规范真实路径。

```sh
node scripts/adopt-private-space.mjs \
  --backup /absolute/backups/first-offline-snapshot \
  --manifest-sha256 REPLACE_WITH_64_LOWERCASE_HEX \
  --data-root /absolute/collaboration-data \
  --space-id sp_REPLACE_WITH_32_LOWERCASE_HEX \
  --owner-username EXISTING_OWNER_USERNAME \
  --offline-confirmed
```

导入过程持有同 gateway 相同的 `gateway.lock`（排他创建），任何已有锁都会阻断。正常异常清理本次 staging、尚未完成的新目标并释放自己的锁；不偷取或删除别的锁。整个导入期间 gateway 不能启动，旧内容写入者也必须保持停止。

工具先复制 identity.sqlite 及其 WAL/journal 到私有 staging，在副本验证 identity schema v1、私人空间 `kind=private`、ownerUsername→ownerId 归属、只有该 owner 成员、没有该私人空间的邀请；不打开源身份库写入、不读取或输出密码字段内容。导入前后再次比较源身份库及 sidecar 指纹。

输入当前仅支持**唯一 workspace 和唯一 SQLite 内容数据库**（state 可以是目录或含 sidecar 的单文件 bundle）；不能混入另一个结构化 JSON 域文件、第二个 DB、未知域或其他无明确导入规则的状态。已识别域是 `workspace` v2、`pkw` v1、`pkw_notes` v3、`pkw_attachments` v1、`pkw_tasks` v1、`pkw_weknora_sync` v3。workspace 注册表的身份是 **table key**，其 value 不包含 workspaceId；注册表/global 的顺序、唯一性和 pendingMutation 均会核对，待恢复的注册操作会阻断导入。

在隔离副本中，唯一显式数据变更是 `u_workspace_workspaces` 的原 workspaceId 对应 JSON 记录里的 `path`，从旧绝对路径映射到新目标 `<dataRoot>/spaces/<spaceId>/workspace`。其余字段（含 sessionIds、创建/更新时间及未知附加字段）、原 workspaceId、全部 PKW ID、事件、global、各表、schema 和域版本保持不变。每个非 workspace 注册表的完整逻辑摘要在修改前后均须一致。

成功目标为：

```text
<dataRoot>/spaces/<spaceId>/
  workspace/                 # 全部 canonical 文件及回收站
  state.sqlite               # 自包含内容库，仅注册路径映射改变
  adoption-receipt.json       # 最终导入成功标记
```

即使目标目录为空，只要已经存在就拒绝。导入采用 staging、独占目标目录创建和 gateway 锁；普通异常不留半个目标。进程被 kill/掉电可能留下锁和中间目录，这时 gateway 的锁会继续阻断启动。必须核查 receipt、源与目标文件后再安排恢复，**不可为了启动服务直接删锁**。

`adoption-receipt.json` 包含源清单 SHA、源指纹、原 workspaceId、所有稳定 ID、账号/私人空间绑定、路径映射前后值哈希、修改前后 DB 文件/逻辑哈希、保持不变的逐表摘要及版本。`identityStoreModified=false`、`originalSourcesModified=false`，并明确 `runtimeAcceptance=not_run`、`canStartNewVersion=false`。导入主机可能不能访问源服务器路径，所以 `sourceFreshness=not_checked_on_import_host`；源主机仍必须在正式切换前运行前文的 `verify-source`，不能用一份过时备份覆盖后来新增的数据。

导入的 Node API 为 `adoptPrivateSpace({ backup, manifestSha256, dataRoot, spaceId, ownerUsername, offlineConfirmed: true })`，CLI stdout/退出码沿用前表。后续真实 Harness 验收必须打开这个导入副本，确认沿用原 workspaceId、所有内容可读，且其他账号无法访问该私人空间。该验收由部署/集成步骤给出独立证据，工具不会自行把 `not_run` 改成通过。

新增验证：`node --test scripts/tests/data-preservation.test.mjs scripts/tests/adopt-private-space.test.mjs`。覆盖只改注册路径、逐表/全局/身份保持、WAL 身份源不变、所有者/成员/邀请边界、已有空间不覆盖、并发锁、各阶段异常清理与重试、身份与恢复文件中途变化拒绝、分散 JSON 事件库拒绝以及未识别身份 schema 拒绝。


## 本地真实 Harness 验收证据

已新增 `packages/pkw/web/tests/collaboration-migration.spec.ts`，使用实际 `createSpaceRuntime`、Harness SQLite/WorkspaceRegistry 和真实 `IdentityStore`。该测试实际写入中文笔记、二进制附件链接、父子任务及日期、矩阵、Note/Attachment/Folder/Task 回收站和事件，关闭旧 runtime 后用单 SQLite bundle 备份，导入新账号私人空间，再连续两次打开目标。

实际结果：原 workspaceId 未变、注册表仍只有一行；Note/附件/任务/矩阵/旧事件 ID 保留；原正文与 contentHash、附件 bytes 一致；回收内容可恢复；导入后 CAS 编辑笔记、清空任务截止日期后第二次打开仍持久；源工作区和源数据库指纹不变。测试未修改版本 header，未删除或弱化旧数据断言。

本轮验证：单空间保全/导入测试 **41/41**（保全 25，导入 16），整根冷备/恢复测试 **18/18**，真实 Harness 迁移集成 **2/2**，仓库 typecheck 通过。运行命令：

```sh
node --test scripts/tests/data-preservation.test.mjs scripts/tests/adopt-private-space.test.mjs
DSH_HARNESS_ROOT=/absolute/verified/harness pnpm exec vitest run packages/pkw/web/tests/collaboration-migration.spec.ts
DSH_HARNESS_ROOT=/absolute/verified/harness pnpm typecheck
```

以上是受控临时资料的真实运行时证据，**不是生产服务器现有资料的迁移验收**。工具 receipt 继续保留 `runtimeAcceptance=not_run`，避免把通用工具调用等同于另一个验收步骤；本集成测试结果由测试报告单独记录。

## 整个多人协作根目录的冷备与恢复

已实现 `scripts/collaboration-backup.mjs`，支持 `backup`、`verify`、`verify-source`、`restore`、`approve-recovery`。此工具覆盖整个协作应用根目录：identity.sqlite、所有空间的内容 SQLite、canonical 文件/回收站、共享/导入回执以及根内其他配置文件。部署环境变量或根目录之外的检索配置/密钥不在此文件集合中，须按真实部署另行保全。

备份和校验步骤（路径仍为占位符）：

```sh
node scripts/collaboration-backup.mjs backup \
  --data-root /absolute/collaboration-data \
  --output /absolute/backups/collaboration-cold-001 \
  --offline-confirmed

node scripts/collaboration-backup.mjs verify \
  --backup /absolute/backups/collaboration-cold-001 \
  --manifest-sha256 REPLACE_WITH_64_LOWERCASE_HEX

node scripts/collaboration-backup.mjs verify-source \
  --backup /absolute/backups/collaboration-cold-001 \
  --manifest-sha256 REPLACE_WITH_64_LOWERCASE_HEX \
  --offline-confirmed
```

运行前按实际部署方式停 gateway 及所有外部写入者。备份/源检查期间工具排他持有同一个 `gateway.lock`，不偷锁；这把维护锁是源目录唯一的临时写入，canonical 文件和源 SQLite 不打开写入。锁文件本身不进入备份。源指纹忽略维护锁引起的**根目录自身** mtime/ctime/size，其他目录/文件、结构和时间仍纳入检测。复制前后及完成前发生任何源变化都会拒绝结果；`verify-source` 检查后必须继续保持停写。

整根清单格式为 `pkw-collaboration-backup` / `version=1`，包含原始 `sourceInventory`/`payload`、各 SQLite 的 `normalized`/`logicalSha256`、身份账本及各空间对账。`raw/` 保存主库/WAL/SHM/journal 的原始字节；`sqlite/` 保存经 integrity/foreign-key 检查、逻辑摘要等价的自包含副本。SQLite 格式的附件仍作为 canonical 二进制逐字节保留，不会被误当应用 DB 重写。

`analysis.identity` 列出账号 ID/用户名、spaceId/ownerId、成员角色、会话/邀请数量和审计行数，不输出密码/令牌内容。`analysis.spaces` 区分 initialized、uninitialized、blocked。账号创建后还未打开的私人空间在身份库存在、目录不存在属于正常 `uninitialized`；有目录但缺失 workspace/state、孤儿目录、错误引用、未知 schema 会阻断激活而不是静默略过。

### 恢复、旧凭据作废与成员复核

```sh
node scripts/collaboration-backup.mjs restore \
  --backup /absolute/backups/collaboration-cold-001 \
  --manifest-sha256 REPLACE_WITH_64_LOWERCASE_HEX \
  --target /absolute/recovery/collaboration-restored \
  --offline-confirmed
```

目标必须不存在，绝不覆盖已有 root。恢复将副本中的每个已知 workspace v2 注册路径显式映射到新根，保留原 workspaceId 和业务记录；完整 identity 列顺序与当前 IdentityStore v1 契约逐表核对，未查询的密码列也不能缺失/改名；其他空间数据、文件、共享/导入回执及版本保持。identity 的 accounts、spaces、members、audit 和其他非凭据表逐表摘要保持不变；**恢复副本中的 sessions 与 invitations 清空**，receipt 记录作废数量，防止旧登录态和旧邀请重新生效。所有者正常密码登录仍可在批准恢复后使用。

恢复从开始即保留 incomplete gate，完成标志先写临时文件并 fsync，再以原子 rename 覆盖，避免保护文件消失的空窗。恢复会写：

- `recovery-pending.json`：启动保护文件。gateway 和 space runtime 都拒绝在其存在时启动。
- `.recovery/<operationId>/receipt.json`：绑定源清单 SHA、旧/新根路径、各空间路径映射、身份/凭据变化摘要、完整恢复文件清单及 `canApprove`。

旧版本和未知 schema 仍可保真恢复为取证副本，但 `canApprove=false`，任何批准命令都不能绕过。未知 identity schema 无法安全猜测凭据表语义时不会擅改它，保护文件保持阻断，必须先完成有针对性的迁移适配。已知 identity schema 的会话/邀请会作废，即使另一空间需要旧版本适配。

**备份中的成员权限是备份时点的历史事实。** 例如某员工在备份之后被移除，恢复旧成员表不能被当作该员工现在仍应有访问权。先阅读 `verify` 报告中的 `analysis.identity.accounts/spaces/members` 与恢复 receipt，并核对实际人员/角色。若源还可用，`verify-source` 会明确指出后来发生的撤权/新写入，不能把旧快照作为当前完整状态直接切换。若发现权限需要修正，保留 gate 并进行经审核的离线修正/重新恢复；不能通过删 gate 启动来“以后再修”。

复核完成后，由本机管理员明确执行：

```sh
node scripts/collaboration-backup.mjs approve-recovery \
  --data-root /absolute/recovery/collaboration-restored \
  --offline-confirmed \
  --reviewed-memberships
```

批准前重新验证 receipt、所有恢复文件、当前成员摘要，确保旧会话/邀请仍为空；文件或权限漂移即拒绝。成功写入 `.recovery/<operationId>/approval.json`，其中保留实际复核的账户/空间/角色、时间及绑定指纹，再移除保护文件。若在 approval 写入后、gate 删除前中断，可重新运行同命令核验后完成，不重复改数据。此操作不代替目标运行时/网络权限验收，报告仍为 `runtimeAcceptance=not_run`。

普通失败会清理本次新目标/临时副本并释放自己的锁，源与备份不变；kill/掉电可能留下 incomplete gate/锁，必须检查后用新目标重新恢复，不允许直接删锁或 marker 强行启动。启动后产生的新资料不能拿旧冷备覆盖。所有 CLI 采用同一 JSON/退出码契约。

### 整根实际验证

`node --test scripts/tests/collaboration-backup.test.mjs`：**18/18 通过**。覆盖两个有资料的空间+一个未打开空间、多库 WAL、旧/未知/非法 identity schema 阻断、全根源漂移、非空/重叠/符号链接拒绝、失败清理/重试、篡改与恶意清单、恢复文件变动、旧成员风险、共享回执保留、SQLite 附件原始字节、会话/邀请作废、审批后文件/权限漂移拒绝、审批中断续跑。

真实 Harness 集成文件另覆盖整根恢复：真实 IdentityStore 建两个账号/团队关系及旧登录/邀请，真实 runtime 写两个隔离空间，冷备后跨根恢复，实际 gateway 在 gate 存在时拒绝启动；审批后 gateway 正常启动、两空间保留原 workspaceId/内容/Task 且互相不能读取对方笔记，成员/审计不变，旧会话与邀请归零。加上前述私人空间导入，集成 **2/2 通过**。这是受控本地数据的实际程序证据，实际服务器停写/备份/恢复/权限复核和切换仍未执行。
