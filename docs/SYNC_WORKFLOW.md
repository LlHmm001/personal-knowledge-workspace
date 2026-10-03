# 两端同步工作流 — 本机 Codex CLI ↔ 云端容器

> 最新构建、部署与测试状态见 [DELIVERY_STATUS.md](DELIVERY_STATUS.md)。下文的问题清单保留接手时背景。

> **目的**：让「云端容器（DSH 运行环境）」和「你本机的开发端（ChatGPT Codex CLI / IDE 扩展）」
> 通过 GitHub 保持同一份代码，并且**永远不产生需要人工仲裁的分叉**。
>
> **一句话原则**：**GitHub 是唯一的中转站，两边都不直接改对方的文件。**

---

## 0. 拓扑

```
   本机开发端                          云端容器（这里）
   Codex CLI / IDE                     DSH 运行环境
   ~/dev/pkw                           /LlHmm9527/Personal Knowledge Workspace
        │                                        │
        │  git push                              │  git pull
        ▼                                        ▼
   ┌──────────────────────────────────────────────────┐
   │        GitHub: LlHmm001/personal-knowledge-workspace                 │
   │        （唯一真相源，唯一中转站）                  │
   └──────────────────────────────────────────────────┘
```

**规则**：任何一边都不"直接同步"另一边。所有流动都经过 GitHub。
这样任何时刻断网、关机、容器重启，都不会丢东西，也不会出现"两边各改一半"。

---

## 1. 一次性设置

### 1.1 云端容器（这里）

容器里**没有** `gh` CLI，也**没有**任何 GitHub 凭据。二选一：

**方案 A — HTTPS + Personal Access Token（最简单）**

```bash
cd "/LlHmm9527/Personal Knowledge Workspace"
git remote add origin https://github.com/LlHmm001/personal-knowledge-workspace.git
git config credential.helper store      # 首次 push 输入 token 后会记住
git push -u origin main
```

> token 需要 `repo` 权限（细粒度 token 则给 **Contents: Read and write**）。
> 把它当密码用，**不要**写进任何被提交的文件；`git config` 存在 `.git/config`，
> 该文件不在版本控制内，但仍建议用短期 token 并及时撤销。

**方案 B — SSH key**

```bash
ssh-keygen -t ed25519 -C "pkw-cloud" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub          # 把输出加到 GitHub → Settings → SSH keys
ssh -T git@github.com              # 验证
cd "/LlHmm9527/Personal Knowledge Workspace"
git remote add origin git@github.com:LlHmm001/personal-knowledge-workspace.git
git push -u origin main
```

### 1.2 本机开发端

```bash
git clone https://github.com/LlHmm001/personal-knowledge-workspace.git pkw
cd pkw
git config user.name  "你的名字"
git config user.email "你的邮箱"
pnpm install
```

> **注意**：`pnpm typecheck` 需要 harness checkout（见 `docs/HANDOVER.md` §7）。
> 本机开发时要么准备 `DSH_HARNESS_ROOT`，要么只跑 `pnpm test` 中不依赖 harness 类型解析的部分。

---

## 2. 日常循环（最重要的部分）

### 情形 A：你在本机用 Codex 升级 → 回到云端

```bash
# ── 本机 ──────────────────────────────────────────
cd ~/dev/pkw
git switch -c feat/xxx            # 一个任务一个分支，别直接在 main 上写
# …让 Codex 干活…
git add -A && git commit -m "feat(pkw): …"
git push -u origin feat/xxx
# 在 GitHub 上开 PR → 合并进 main（或直接推 main，见 §3）
```

```bash
# ── 云端（这里）────────────────────────────────
cd "/LlHmm9527/Personal Knowledge Workspace"
git fetch origin
git switch main                 # 主分支已核实为 main
git pull --ff-only origin main
pnpm install                      # 依赖变了才需要
pnpm typecheck && pnpm test       # 先验证再谈部署
```

### 情形 B：云端改了东西 → 回到本机

```bash
# ── 云端 ──────────────────────────────────────
cd "/LlHmm9527/Personal Knowledge Workspace"
git switch -c fix/yyy
git add -A && git commit -m "fix(pkw): …"
git push -u origin fix/yyy
```

```bash
# ── 本机 ──────────────────────────────────────
cd ~/dev/pkw
git fetch origin && git switch main && git pull --ff-only
```

### 开工前的铁律

```bash
git fetch origin && git status
```

**每次开始写代码之前都要做**。如果本地有未推送的提交，或者远端有你没有的提交，
**先解决同步再动手** —— 这是唯一能避免分叉的时刻。

---

## 3. 分支策略（二选一，但必须选一个）

### 策略 1：单人直接推 main（简单，推荐给你现在的规模）

- 两边都直接 `git push origin main`。
- **代价**：没有 CI 拦截的机会；推坏了要 revert。
- **前提**：`pnpm typecheck` 必须绿，`pnpm test` 必须稳定绿（**现在还不绿，见 §5**）。

### 策略 2：PR 流程（更稳，适合 Codex 多产出的场景）

- Codex 在 `feat/*` / `fix/*` 分支上干活，开 PR。
- CI（`.github/workflows/ci.yml`）在 PR 上跑 typecheck + test。
- 绿了才合并进 `main`；云端永远只 `pull main`。
- **推荐**：这样云端只需要"拉取"，永远不会产生需要仲裁的分叉。

---

## 4. 冲突怎么处理

**预防**（比处理更重要）：

1. 一个任务一个分支，任务结束就合并，别攒着。
2. 一端的改动没推完，就不要在另一端开始改同一批文件。
3. `packages/pkw/web/src/ui.ts` 是**最容易冲突**的文件（大文件、UI 修改密集）。
   改它之前先 `git pull`，改完**立刻**推。

**真冲突了**：

```bash
git fetch origin
git rebase origin/main      # 或 merge，二选一但全仓保持一致
# 解决冲突 → git add → git rebase --continue
pnpm typecheck && pnpm test   # 冲突解决后必须重新验证
git push --force-with-lease   # 只有 rebase 后需要；绝不用 --force
```

> **`--force-with-lease` 而不是 `--force`**：前者在远端有你不知道的新提交时会拒绝，
> 避免覆盖别人（或另一台机器上的你）的工作。

---

## 5. 当前会挡住同步的问题（先解决再谈流畅）

| 问题 | 影响 | 处理 |
| --- | --- | --- |
| `pnpm test` 不稳定（1~6 个失败浮动） | CI 会随机红，无法用"CI 绿"作为合并门槛 | 见 `docs/HANDOVER.md` §8.1，先修竞态 |
| 仓库源码 ≠ 线上产物（无构建/发布管线） | **推了代码线上也不会变** | 见 `docs/HANDOVER.md` §6.3 |
| 线上 `lib/ui.js` 有手工改动未回流 | 仓库不是唯一真相源，同步会丢东西 | 见 `docs/HANDOVER.md` §9 P0-3 |
| `@deepseek-ai/*` harness 依赖无法从公网安装 | 本机开发环境装不齐类型 | CI 里用 `HARNESS_REPO_URL` 变量；本机见 §1.2 说明 |

**在 `pnpm test` 稳定之前，建议先用策略 2（PR）而不是直推 main** ——
否则一次随机红的推送就会让两端的基线都变得不可信。

---

## 6. 让 Codex 高效工作的信息

Codex 在本机 clone 之后，**先让它读这两份**：

1. **`docs/HANDOVER.md`** —— 项目是什么、边界在哪、升级从哪下手。
   §4（冻结决策）和 §9（升级路线）是它最需要的部分。
2. **`docs/CODEBASE_MAP.md`** —— 具体代码在哪。

然后给它一个**带验收标准的任务**，例如：

> 按 `docs/HANDOVER.md` §9 的 P0-1 和 P0-2，为全部 `packages/pkw/*` 增加 `build` 脚本并写入
> 根 `pnpm build`，新增 `scripts/deploy-pkw.sh` 完成 build → publish 到本地 registry →
> profile install → 重启验证。验收：仓库内 `pnpm build` 产出 `lib/*.js`，
> 且 `docs/HANDOVER.md` §6.3 的流程可被一条命令执行。

不要给它"优化一下这个项目"这种没有验收标准的任务。

---

## 7. 速查卡

```bash
# 开始工作前（两端都一样）
git fetch origin && git status

# 云端：把本机的改动拿过来
git switch main && git pull --ff-only origin main

# 本机：把云端的改动拿过来
git fetch origin && git switch main && git pull --ff-only

# 看两边差多少
git log --oneline origin/main..HEAD      # 我领先的
git log --oneline HEAD..origin/main      # 我落后的

# 确认没把秘密推上去
git status --short
git diff --cached | grep -iE 'api[_-]?key|secret|token' | head
```
