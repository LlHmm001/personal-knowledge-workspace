## 改了什么

## 为什么

<!-- 对应哪个 issue / 债务条目 -->

## 怎么验证

<!-- 贴实际运行的命令与输出；没跑的写"未验证" -->

| 层级 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| typecheck | `pnpm typecheck` | |
| 单元 / 集成 | `pnpm test` | |
| 部署后验证 | 重启后访问 `/pkw` | |

## 影响哪些不变量

- [ ] `NoteId` / `AttachmentId` 稳定性
- [ ] `relativePath` 未被当作身份
- [ ] 用户数据（Markdown / 二进制 canonical）无迁移风险
- [ ] 未引入第二份 canonical 存储
- [ ] 未泄漏 WeKnora remote id 给用户
- [ ] 未触及 `docs/PHASE_1_CLOSURE.md` 的冻结决策

## 备注
