# 开发团队审查与修复记录

日期：2026-10-02。审查基线：`chore/pkw-delivery@b379818`。

范围：Notes / Attachments / Tasks / WeKnora sync 的数据一致性、并发和恢复行为。
所有验证都在本机临时工作区和内存 SQLite 上进行；未连接或修改生产数据、服务或 WeKnora。
Markdown、Attachment binary、Task Store 的 canonical 地位及稳定身份保持不变。

## 按价值排序的五项发现

| 任务 | 状态 | 下一步 | 完成标准 | 验证证据 | 风险 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 Note 生命周期按路径误操作其他身份 | 已修复并本机验证 | 合并后复核真实文件系统与目标机 | 移动/恢复不覆盖已有文件；清空旧回收项保留复用路径的新 Note；文件夹成员按归档 NoteId 操作 | 修改前 5 个覆盖/误删回归失败；修复后通过，另补文件夹成员和单项恢复/清除回归 | 原行为可丢失正文或活动索引，优先级 P0 | 不迁移 archive 布局；已有归档冲突安全拒绝 |
| D2 外部重命名被 reconcile 误判删除 | 已修复并本机验证 | 目标环境验收 | 相同 NoteId 新路径仍活动，保留修订号和业务元数据；再次 reconcile 无变化 | 修改前重命名后 deletedAt 有值；修复后回归通过 | 误删状态可向远端删除流程传播，优先级 P0 | 路径只作位置，不再作为 reconcile 身份来源 |
| D3 自动摘要覆盖用户随后保存的正文 | 已修复并本机验证 | 根任务验证网页保存条件与集成 | 旧快照派生写入被拒绝；下一轮重读后合并，用户正文保持 | 受控交错先复现用户正文被替换；加条件写入后本轮返回 false，随后合并成功 | 直接丢失用户正文，优先级 P0 | 条件写入是可选兼容接口，所有调用方应按自身快照传条件 |
| D4 外部附件增大导致读取与 reconcile 失败 | 已修复并本机验证 | 目标存储适配器验收 | 使用当前文件大小作有限读上限，完整计算新哈希/大小，二次 reconcile 幂等 | 1 字节附件改成 46 字节，修改前抛 FS_TOO_LARGE，修改后全文/哈希/修订检查通过 | 单个外部修改可中断整次 reconcile，优先级 P1 | 读取中继续增长仍安全失败，待下一次观察后重试 |
| D5 Task matrix 关系缺少服务层完整约束 | 第二轮已修复并本机验证 | 根任务集成与全量验证 | 新写入拒绝非法引用；删除不留下活动孤儿；失效归属恢复到 Inbox/顶层 | 新增 7 个回归在旧代码全部失败；补并发和存储失败检查后定向通过 | Task 仍存储但导航不可达，优先级 P1 | 规则经产品团队独立审查；详见第二轮记录 |

## D1：用归档身份确定删除/恢复对象

原触发过程：创建 A → 删除 A → 同路径创建 B → 清空 A。旧 `purge()` 同时删除 archive
和 canonical 原路径，结果 B 的正文消失。旧 `move()` / `restore()` 使用 Node 的覆盖式
rename，可覆盖另一篇 Note；再次删除同路径 B 也会覆盖 A 的归档。

修复位于 `packages/pkw/notes/src/index.ts`：

- `moveFile`（约 162 行）对文件使用独占目标 hard-link 后 unlink，目标已占用直接失败；目录先检查冲突，再 rename。
- `createLocked`（约 301 行）拒绝已属于现存 Note 的显式 NoteId，队列同时覆盖并发创建。
- `archivedNoteTarget`（约 199 行）按文件 frontmatter NoteId 搜索普通归档或 FolderTrashEntry 内路径；多个匹配拒绝操作。
- `purgeLocked`（约 502 行）只处理 trashed Note 的匹配归档，不删除原 canonical 路径；只有路径索引仍属于该 Note 时才移除。
- `archivedFolderNotes`（约 761 行）、`restoreFolderLocked`、`purgeFolderLocked` 从选中归档的 Markdown 读取真实成员 NoteId，保护同名新文件夹的现存 Note。

单篇 Note 从整个文件夹回收项中单独恢复/清空也已覆盖：清空单篇后再恢复文件夹不会复活该 Note。
文件夹删除的故障顺序也已调整：先保存稳定恢复入口，再实际移动，最后才记删除事件和 Note 投影。
移动失败且源目录完整时撤销恢复入口，Note/事件完全不变；移动成功后事件存储失败时保留归档和
恢复入口，已验证可通过 `restoreFolder` 恢复。两个故障注入回归在修改前失败，修改后通过。
这不是文件系统与事件数据库之间的原子事务；不明确的移动结果保留恢复入口供排查，不伪报回滚成功。
普通文件目标独占依赖同一文件系统支持 hard-link；不支持时操作失败且源文件不被删除。
若在 link 与 unlink 之间进程退出，会保留两处相同身份供冲突处理，不自动丢弃其中一份。

## D2：reconcile 按 NoteId 对比

`packages/pkw/notes/src/index.ts:524` 开始的 `reconcileLocked` 改为从 NoteIndex 按
NoteId 找之前状态，保留 `attachmentBacked`、创建时间等已有元数据，迁移过时的路径索引。
无正文变更的移动不虚增正文修订号。外部删除由“观察中不存在该身份”判定，不再把旧路径缺失
等同于该 Note 消失。原有重复身份报告仍保留。

## D3：摘要与用户编辑之间的条件写入

`packages/pkw/domain/src/types.ts:284` 新增 `NoteUpdateOptions` 与
`NoteUpdateConflictError`，保持原两参数 `update` 调用兼容：

```ts
notes.update(noteId, markdown, {
  expectedRevision: snapshot.note.observedRevision,
  expectedContentHash: snapshot.note.contentHash,
})
```

`packages/pkw/notes/src/index.ts:148` 的 workspace 写队列串行化当前 NotesService 实例的
canonical 读快照、写入、移动、删除、恢复、目录操作和 reconcile。`updateLocked`（约 352 行）
在该队列内验证当前修订号及当前文件哈希，再写入；失败不会阻断后续操作。
正文快照的哈希来自实际返回的 Markdown，因此重新读取外部修改后的文件可以安全再次保存。
内部方法不调用再次排队的公共变更方法；`deleteFolder` 作为不持锁的别名委托到 `trashFolder`。

`packages/pkw/weknora-sync/src/index.ts:521` 在 summary 派生写入时带上两个条件；冲突本轮不写，
下一轮重读当前正文再生成 managed summary，仍复用原业务 Note 和 Knowledge 身份。

验证覆盖：用户保存插入 summary 的读/写间隙；两个相同快照写入仅一次成功；冲突后队列可继续；
外部文件内容已改变时拒绝旧 hash；保存与文件夹移动重叠时只留下新路径的一份正文。

保证边界：这是当前 NotesService 实例内的协调，不是跨进程文件锁。外部编辑器在最终检查之后
继续写入的极窄竞争仍需宿主提供的条件写入/共享锁协议；旧调用方未传条件仍保持原覆盖保存语义。
这里不替代网页多客户端保存流程的独立验收，网页由根任务和设计交互团队集成。

## D4 与 D5 的源码位置

- Attachments：`packages/pkw/attachments/src/index.ts:174` 的 `open` 与 253 / 275 行的
  reconcile 读取使用本次 stat 大小，替换旧 catalog 大小上限。仍保留有限 byte cap，不放开无限读取。
- Tasks（第一轮基线）：`packages/pkw/tasks/src/index.ts` 原 127 / 149 行的 bulk reassignment 和 matrix removal
  缺少目标存在/自指校验；231 / 252 的 create/update 存储引用未验证；331 的 restore 未处理 matrix
  已删除后的归属。这些问题已在第二轮按下述规则实现；不能用“矩阵列表正常”代替数据关系验收。

## 实际验证

Harness：`/Users/mac/Desktop/开源项目/output/dsh-updater-0.4.0/clean-fixed`，
与生产版本是否相同仍未核实。

```sh
DSH_HARNESS_ROOT='<上述本机 Harness 路径>' pnpm exec vitest run \
  packages/pkw/notes/tests/notes.spec.ts \
  packages/pkw/weknora-sync/tests/sync.spec.ts
DSH_HARNESS_ROOT='<上述本机 Harness 路径>' pnpm typecheck
```

- 第一轮最后一次定向运行：2 个文件、93 项测试全部通过（Notes/Attachments 45，sync 48）。
- 最后一次 typecheck：退出码 0。
- 原有断言和定时器驱动测试保留，未拉长超时，未删除失败检查。
- 根任务仍需执行全量测试、构建、打包运行和网页验收；本报告不代报这些结果。
- 无 schema 迁移、无生产发布/重启、无真实远端删除。生产验收不在本机测试通过的含义内。

## 第二轮：Task 引用和生命周期

范围限制为 `packages/pkw/tasks/**`。沿用 Task Store canonical、稳定 TaskId、独立的 matrix
归属和 sourceRefs；没有新增 Task 硬删除 API，也没有更改 schema。不存在的 Task purge 能力
没有被假定为已实现。以下恢复规则已经产品团队独立检查，与现有 Inbox 和子任务提升规则一致。

### 完成标准与实现

| 任务 | 状态 | 下一步 | 完成标准 | 验证证据 | 风险 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 引用写入保护 | 本机通过 | 根任务集成 | create/update/move/bulk-reassign 拒绝不存在的 matrix；创建/重设父任务拒绝不存在或已删除父任务；禁止自指迁移后删除 matrix | 无效目标原先能存储，新回归先红后绿 | 高 | 拒绝前不修改 Task/Matrix |
| 矩阵删除与回收任务 | 本机通过 | 网页流程联验 | 删除 matrix 前解除所有已回收任务的 matrix 引用，保留 deletedAt/内容/身份；活动任务按用户原 disposition 迁移或回收 | 回收任务删除矩阵后恢复到 Inbox，sourceRefs 和 important 保持 | 中 | 回收任务不会因删除 matrix 被恢复 |
| 跨矩阵父子关系 | 本机通过 | 网页层展示验收 | 仅删除目标 matrix 成员；其他 matrix 的活动子任务提升顶层，不被级联删除 | 跨矩阵子任务完整保留 | 高 | 不自动改变子任务自身 matrix |
| 单项恢复 | 本机通过 | 网页流程联验 | 原 matrix 缺失/已归档则恢复到 Inbox；祖先任务缺失/已删除/成环或祖先 matrix 缺失/归档则提升顶层；有效关系保留 | 子任务先恢复、已归档 matrix 恢复、父任务藏于归档 matrix 时 Inbox 根任务可见的回归通过 | 中 | `task.restored` 事件记录恢复前后归属 |
| 并发和失败后状态 | 本机通过 | 完整集成 | matrix 删除与 Task 创建不可交错出孤儿；两个 reparent 不形成环；失败后队列可继续，已完成的局部写入不伪报整体回滚 | 受控暂停 matrix 删除、并发环、child/parent put 故障注入通过 | 高 | 不宣称批量修改跨记录原子 |
| 日期清除与写入合法性 | 本机通过 | 网页联验 | 空字符串明确清除日期；null/非法记录在落盘前拒绝；不可变字段不能通过运行时 patch 提交 | 真实 SQLite 关闭重开，日期清除仍在且合法日期原样保持；非法 status/priority/sourceRefs/title 拒绝；另一合法 TaskId 的覆盖请求拒绝 | 高 | 复用原有 valueSchema，不改 schema |

源码：`packages/pkw/tasks/src/index.ts` 中 `withMutation`（约 66 行）、引用校验（72 / 78 行）、
`normalizeDate`（93 行）、幸存子任务提升（100 行）、回收任务 matrix 解除（109 行）、
`removeMatrixLocked`（225 行）、`removeMatrixWithTasksLocked`（252 行）、
`updateTaskLocked`（366 行）和 `restoreTaskLocked`（477 行）。

普通 `updateTask` 不再允许直接修改 `deletedAt`，避免绕过 delete/restore 生命周期；已回收的
Task 需先恢复才能编辑/移动/完成。创建和更新的合法 sourceRefs、重要/紧急和独立 matrix 语义保持。

日期协议：`dueAt: ''` / `scheduledAt: ''` 表示明确清除，服务层保存为可选字段缺省；不发送字段
表示保持原值，非空 string 原样保持，null 拒绝。协议已同步设计交互团队。
宿主 `KvTable.put` 不校验记录，只有重开时校验，因此 create/update 复用现有
`taskDomainSpec.tables.*.valueSchema.parse()` 在写入前阻止非法数据。Task schema 版本仍为 1。
`taskId` / `workspaceId` / `createdAt` 的运行时 patch 显式拒绝；原实现虽然最终重新赋回旧值，
现在不再默默接受这种无效身份变更请求，也不会产生无效更新事件。

### 故障与并发边界

TasksService 的实例内队列把引用检查和写入放在同一个顺序内，覆盖该服务的所有公开变更。
内部批量操作调用 Locked 私有方法，避免再入排队造成自锁；拒绝不会阻塞下一次有效操作。
它不是跨进程锁，不替代数据库外键或多记录事务。

单项删除先提升活动子任务，再回收父任务；如果提升失败，父任务仍然活动。
批量删除先提升范围外幸存子任务，范围内按子任务先、父任务后的顺序回收，最后删除 matrix。
注入父任务写入失败时，已回收的子任务仍可恢复，父任务与 matrix 保留，重试可以继续完成。
任务记录和 durable 事件仍是两个存储步骤：如果后续事件提交失败，已经完成的 canonical Task
写入会保留，不能声称事务回滚或一次请求全有全无。新的代码控制引用关系和故障顺序，未引入 outbox。

### 第二轮验证

```sh
DSH_HARNESS_ROOT='<上述本机 Harness 路径>' pnpm exec vitest run packages/pkw/tasks/tests/tasks.spec.ts
DSH_HARNESS_ROOT='<上述本机 Harness 路径>' pnpm typecheck
```

首次新增 7 项故障回归：旧代码 7 失败 / 原有 15 通过。实现并补充并发、故障与归档恢复验证后：
加上日期持久化、非法输入、不可变字段及归档父任务可见性验证后，最终 **30 项 Task 测试全部通过，typecheck
退出码 0，diff check 通过**。SQLite 重开沿用同一路径、同一 WorkspaceId，TaskId 与来源保留。

仍待项：生产数据/目标 Harness 验收、历史孤儿关系的显式批量修复方案、跨记录事件事务性。
恢复路径会安全处理本次被恢复 Task 的失效关系；未静默扫描或改写历史全部数据。
