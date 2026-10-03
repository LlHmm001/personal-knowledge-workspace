/** Small, dependency-free account/space portal. All user-supplied strings use textContent. */
export function renderPortal(): string {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PKW · 我的空间</title>
<style>
:root {
  color-scheme:light dark;
  --bg:#f3f5f8;
  --card:#fff;
  --ink:#182334;
  --muted:#617187;
  --line:#d7dfeb;
  --accent:#245fd0;
  --tint:#e9f0ff;
  --danger:#b22b38;
}
* {
  box-sizing:border-box;
}
body {
  margin:0;
  background:var(--bg);
  color:var(--ink);
  font:16px/1.6 system-ui,-apple-system,sans-serif;
}
header {
  border-bottom:1px solid var(--line);
  background:var(--card);
}
.bar,main {
  max-width:1080px;
  margin:auto;
  padding:24px;
}
.bar {
  display:flex;
  justify-content:space-between;
  gap:20px;
  align-items:center;
}
.brand {
  font-weight:750;
  font-size:20px;
  letter-spacing:.02em;
}
.muted,small {
  color:var(--muted);
}
h1 {
  font-size:clamp(25px,4vw,34px);
  line-height:1.25;
  margin:0 0 12px;
}
h2 {
  font-size:20px;
  margin:0 0 10px;
}
h3 {
  font-size:17px;
}
.intro {
  margin:24px 0 30px;
  max-width:730px;
}
.grid {
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));
  gap:18px;
}
.card {
  padding:24px;
  background:var(--card);
  border:1px solid var(--line);
  border-radius:16px;
  overflow-wrap:anywhere;
}
.auth {
  max-width:480px;
  margin:40px auto;
}
.space {
  display:flex;
  flex-direction:column;
  align-items:flex-start;
  gap:14px;
  min-height:210px;
}
.space p {
  flex:1;
  margin:0;
}
.badge {
  font-size:12px;
  padding:3px 9px;
  border-radius:999px;
  background:var(--tint);
  color:var(--accent);
}
label {
  display:block;
  font-weight:600;
  margin:14px 0 5px;
}
input,select,button,.button {
  font:inherit;
  min-height:44px;
  border-radius:8px;
  padding:9px 13px;
}
input,select {
  width:100%;
  border:1px solid var(--line);
  color:var(--ink);
  background:var(--card);
}
.remember-login {
  display:flex;
  align-items:center;
  min-height:44px;
  gap:10px;
  font-weight:400;
  cursor:pointer;
}
.remember-login input {
  width:20px;
  min-height:20px;
  height:20px;
  flex:0 0 20px;
  margin:0;
  padding:0;
  accent-color:var(--accent);
}
button,.button {
  cursor:pointer;
  border:1px solid var(--line);
  background:var(--card);
  color:var(--ink);
  text-decoration:none;
  display:inline-block;
}
button.primary,.button.primary {
  background:var(--accent);
  color:white;
  border-color:var(--accent);
}
button:disabled {
  opacity:.55;
  cursor:wait;
}
button.danger {
  color:var(--danger);
}
:focus-visible {
  outline:3px solid var(--accent);
  outline-offset:3px;
}
.row {
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  align-items:center;
}
.actions {
  margin-top:18px;
}
.status {
  position:sticky;
  top:0;
  z-index:10;
  max-width:1032px;
  margin:auto;
  padding:12px 20px;
  background:var(--tint);
  border-radius:8px;
  white-space:pre-wrap;
}
.status[data-error=true] {
  color:var(--danger);
}
[hidden] {
  display:none!important;
}
details {
  margin-top:18px;
}
summary {
  cursor:pointer;
  min-height:44px;
  padding:9px 0;
}
table {
  border-collapse:collapse;
  width:100%;
}
th,td {
  text-align:left;
  vertical-align:top;
  padding:12px 8px;
  border-bottom:1px solid var(--line);
}
td .row {
  gap:6px;
}
.table-wrap {
  overflow-x:auto;
  margin-top:20px;
}
code {
  font-size:12px;
  overflow-wrap:anywhere;
}
#management {
  margin-top:24px;
}
#invite-output {
  margin-top:18px;
}
a {
  color:var(--accent);
}
@media(prefers-color-scheme:dark) {
  :root {
    --bg:#10151d;
    --card:#192230;
    --ink:#e8eef7;
    --muted:#a4b2c6;
    --line:#344255;
    --accent:#86afff;
    --tint:#253650;
    --danger:#ff9aa6;
  }
  button.primary,.button.primary {
    color:#102039;
  }
}
@media(max-width:600px) {
  .bar,main {
    padding:18px;
  }
  .card {
    padding:18px;
  }
  .bar {
    align-items:flex-start;
  }
  .bar .row {
    justify-content:flex-end;
  }
  th,td {
    padding:9px 5px;
  }
}
</style>
</head>
<body>
<header>
<div class="bar">
<div class="brand">PKW <span class="muted">知识工作台</span>
</div>
<div class="row">
<span id="account-label">
</span>
<button id="logout" hidden>退出登录</button>
</div>
</div>
</header>
<div id="status" class="status" role="status" aria-live="polite" hidden>
</div>
<main>
<section id="auth" class="auth card">
<span class="badge">安全登录</span>
<h1 style="margin-top:16px">欢迎回到你的知识空间</h1>
<p class="muted">私人资料只对你开放。加入团队后，你可以访问对应的共享空间。</p>
<p id="session-expired-message" class="muted" role="status" hidden>登录已过期，请重新登录后继续。已保存的资料不受影响。</p>
<form id="login-form">
<label for="username">账号</label>
<input id="username" name="username" autocomplete="username" required minlength="3" maxlength="64" placeholder="例如 xiaoming">
<label for="password">密码</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">
<label class="remember-login" for="remember-me">
<input id="remember-me" name="rememberMe" type="checkbox" autocomplete="off" aria-describedby="remember-device-hint">
<span>在此设备保持登录 30 天</span>
</label>
<small id="remember-device-hint">仅在你自己的设备上勾选；共享或公共设备请不要勾选。</small>
<div class="actions">
<button class="primary" type="submit">登录</button>
</div>
</form>
<details id="register-panel">
<summary>收到邀请，创建账号</summary>
<form id="register-form">
<label for="register-token">邀请码</label>
<input id="register-token" required autocomplete="off">
<label for="register-name">设置账号</label>
<input id="register-name" autocomplete="username" required minlength="3" maxlength="64">
<small>3–64 位字母、数字、点、横线或下划线。</small>
<label for="register-password">设置密码</label>
<input id="register-password" type="password" autocomplete="new-password" required minlength="15" maxlength="1024">
<small>至少 15 个字符，建议使用只有你知道的长短语。</small>
<div class="actions">
<button type="submit">接受邀请并创建账号</button>
</div>
</form>
</details>
</section>
<section id="home" hidden>
<div class="intro">
<span class="badge">我的空间</span>
<h1 style="margin-top:16px">把个人积累与团队协作分开</h1>
<p class="muted">每个空间独立保存笔记、附件和任务。加入团队不会公开你的私人资料。</p>
</div>
<div id="spaces" class="grid">
</div>
<div class="grid" style="margin-top:24px">
<details class="card">
<summary>创建团队共享空间</summary>
<form id="team-form">
<label for="team-name">空间名称</label>
<input id="team-name" placeholder="例如 产品研发组" required maxlength="80">
<div class="actions">
<button type="submit">创建空间</button>
</div>
</form>
</details>
<details class="card">
<summary>使用邀请码加入团队</summary>
<form id="accept-form">
<label for="accept-token">邀请码</label>
<input id="accept-token" autocomplete="off" required>
<div class="actions">
<button type="submit">加入共享空间</button>
</div>
</form>
</details>
<details class="card">
<summary>修改我的密码</summary>
<form id="password-form">
<label for="old-password">当前密码</label>
<input id="old-password" type="password" autocomplete="current-password" required>
<label for="new-password">新密码</label>
<input id="new-password" type="password" autocomplete="new-password" required minlength="15" maxlength="1024">
<small>修改后，所有设备需要重新登录。</small>
<div class="actions">
<button type="submit">修改密码</button>
</div>
</form>
</details>
</div>
<section class="card" style="margin-top:24px" aria-labelledby="share-title">
<h2 id="share-title">把选定的私人笔记复制到团队</h2>
<p class="muted">先预览范围，再由你确认。私人原稿保留，团队副本独立保存；以后修改原稿不会自动更新团队。</p>
<button id="load-share-notes">选择要分享的笔记</button>
<form id="share-form" hidden>
<label for="share-note">私人笔记</label>
<select id="share-note" required>
</select>
<label for="share-target">目标团队空间</label>
<select id="share-target" required>
</select>
<div class="actions">
<button type="submit">预览分享范围</button>
</div>
</form>
<section id="share-preview" hidden style="margin-top:20px">
<h3 id="share-preview-title">
</h3>
<p id="share-scope">
</p>
<pre id="share-body" style="white-space:pre-wrap;max-height:360px;overflow:auto;border:1px solid var(--line);padding:16px;border-radius:8px">
</pre>
<ul id="share-attachments">
</ul>
<ul id="share-warnings">
</ul>
<div class="row">
<button id="confirm-share" class="primary">确认复制到这个团队</button>
<button id="cancel-share">取消</button>
</div>
</section>
<p id="share-result" role="status">
</p>
</section>
<section id="management" class="card" hidden aria-labelledby="management-title">
<div class="row">
<h2 id="management-title" tabindex="-1">
</h2>
<button id="close-management">关闭管理</button>
</div>
<p class="muted">所有者可管理所有成员；管理员可邀请和管理编辑者、只读成员。权限变更对后续请求立即生效。</p>
<div class="row">
<select id="invite-role" aria-label="邀请成员角色">
<option value="editor">编辑者：可整理与编辑资料</option>
<option value="viewer">只读成员：可查看与下载</option>
<option value="admin">管理员：可管理成员和回收站</option>
</select>
<button id="invite-button">创建一次性邀请</button>
<button id="revoke-button">撤销本空间全部未使用邀请</button>
</div>
<div id="invite-output" hidden>
<label for="invite-link">邀请链接（24 小时有效，仅可使用一次）</label>
<input id="invite-link" readonly>
<button id="copy-link" style="margin-top:8px">复制链接</button>
<p class="muted">仅发送给你想邀请的人；收到链接的人可以按选定角色加入。</p>
</div>
<div class="table-wrap">
<table>
<thead>
<tr>
<th>账号</th>
<th>角色</th>
<th>操作</th>
</tr>
</thead>
<tbody id="members">
</tbody>
</table>
</div>
<details>
<summary>最近的管理与资料操作记录</summary>
<button id="audit-button">刷新记录</button>
<ol id="audit">
</ol>
</details>
</section>
</section>
</main><script>
(function () {
    'use strict';
    var session = null;
    var currentSpace = null;
    var sessionGeneration = 0;
    var refreshGeneration = 0;
    var managementGeneration = 0;
    var invitationGeneration = 0;
    var auditGeneration = 0;
    var shareGeneration = 0;
    var feedbackGeneration = 0;
    var operationSequence = 0;
    var authBusy = false;
    var sharePreview = null;
    var shareSource = null;
    var shareCommit = null;
    var entryParams = new URLSearchParams(location.search || '');
    var returnTarget = readReturnTarget(entryParams);
    var roles = { owner: '所有者', admin: '管理员', editor: '编辑者', viewer: '只读成员' };
    function el(id) { return document.getElementById(id); }
    function readReturnTarget(params) {
        var values = params.getAll('next');
        if (values.length !== 1)
            return null;
        var path = values[0];
        var match = /^\/pkw\/spaces\/(sp_[a-f0-9]{32})\/?$/.exec(path);
        // Full equality also rejects the trailing newline accepted by RegExp's $.
        return match && match[0] === path ? { spaceId: match[1], path: '/pkw/spaces/' + match[1] } : null;
    }
    function returnToRequestedSpace(owner) {
        if (!owner.current() || !session)
            return;
        el('session-expired-message').hidden = true;
        if (!returnTarget)
            return;
        // Only a freshly verified session can authorize this navigation. Never
        // copy an arbitrary query value into location or replay a previous write.
        if (!session.spaces.some(function (space) { return space.id === returnTarget.spaceId; })) {
            message('当前账号无法访问刚才的空间。请选择下方可访问的空间，或退出后使用原账号登录。', false, owner);
            return;
        }
        var path = returnTarget.path;
        returnTarget = null;
        location.assign(path);
    }
    // Every asynchronous operation owns the identity and UI domain it started in.
    // The operation may adopt a new generation only when it explicitly starts that transition.
    function context(kind) {
        return {
            auth: sessionGeneration,
            management: kind === 'management' ? managementGeneration : null,
            share: kind === 'share' ? shareGeneration : null,
            invitation: null,
            audit: null,
            feedback: feedbackGeneration,
            current: function () {
                return this.auth === sessionGeneration &&
                    (this.management === null || this.management === managementGeneration) &&
                    (this.share === null || this.share === shareGeneration) &&
                    (this.invitation === null || this.invitation === invitationGeneration) &&
                    (this.audit === null || this.audit === auditGeneration);
            }
        };
    }
    function message(text, error, owner) {
        if (owner && (!owner.current() || owner.feedback !== feedbackGeneration))
            return;
        el('status').hidden = !text;
        el('status').textContent = text || '';
        el('status').dataset.error = error ? 'true' : 'false';
    }
    async function request(path, input, authenticated) {
        var options = { credentials: 'same-origin', headers: {}, cache: 'no-store' };
        if (input !== undefined) {
            options.method = 'POST';
            options.headers['Content-Type'] = 'application/json';
            if (authenticated) {
                if (!session)
                    throw new Error('请先登录');
                // Capture the CSRF token before the first await; never use a later identity.
                options.headers['X-PKW-CSRF'] = session.csrf;
            }
            options.body = JSON.stringify(input);
        }
        var response = await fetch(path, options);
        var result;
        try {
            result = await response.json();
        }
        catch (error) {
            throw new Error('服务器响应暂时不可读取，请稍后重试');
        }
        if (!response.ok || !result.ok) {
            var failure = new Error(result.error || '请求未完成，请稍后重试');
            failure.status = response.status;
            failure.code = result.code;
            throw failure;
        }
        return result.value;
    }
    function manage(input) { return request('/pkw/manage', input, true); }
    function action(control, fn, kind) {
        control.addEventListener('click', function () { return run(control, fn, kind); });
    }
    async function run(control, fn, kind) {
        if (control.disabled)
            return;
        var owner = context(kind);
        owner.feedback = ++feedbackGeneration;
        var operation = ++operationSequence;
        control.portalOperation = operation;
        control.disabled = true;
        message('', false, owner);
        try {
            await fn(owner);
        }
        catch (error) {
            if (!owner.current())
                return;
            if (error.status === 401 && session) {
                showAuth();
                owner.auth = sessionGeneration;
                owner.management = null;
                owner.share = null;
                owner.invitation = null;
                owner.audit = null;
            }
            message(error.message || '操作未完成', true, owner);
        }
        finally {
            // A late operation must not unlock a control used by a newer request.
            if (control.portalOperation === operation)
                control.disabled = false;
        }
    }
    function form(id, fn, kind) {
        el(id).addEventListener('submit', function (event) {
            event.preventDefault();
            return run(event.submitter || this.querySelector('button'), fn, kind);
        });
    }
    function button(text, fn, kind) {
        var control = document.createElement('button');
        control.type = 'button';
        control.textContent = text;
        action(control, fn, kind);
        return control;
    }
    function clearInvitation() {
        invitationGeneration++;
        el('invite-output').hidden = true;
        el('invite-output').querySelector('label').textContent = '邀请链接（24 小时有效，仅可使用一次）';
        el('invite-link').value = '';
    }
    function closeManagement() {
        managementGeneration++;
        auditGeneration++;
        currentSpace = null;
        el('management').hidden = true;
        el('management-title').textContent = '';
        el('members').replaceChildren();
        el('audit').replaceChildren();
        clearInvitation();
        ['invite-button', 'revoke-button', 'audit-button', 'copy-link'].forEach(function (id) { el(id).disabled = false; });
    }
    function lockShare(locked) {
        ['load-share-notes', 'share-note', 'share-target', 'confirm-share', 'cancel-share'].forEach(function (id) { el(id).disabled = locked; });
        el('share-form').querySelector('button').disabled = locked;
    }
    function clearShare() {
        shareGeneration++;
        sharePreview = null;
        el('share-preview').hidden = true;
        el('share-preview-title').textContent = '';
        el('share-scope').textContent = '';
        el('share-body').textContent = '';
        el('share-attachments').replaceChildren();
        el('share-warnings').replaceChildren();
        el('share-result').replaceChildren();
    }
    function showAuth() {
        sessionGeneration++;
        refreshGeneration++;
        closeManagement();
        clearShare();
        shareSource = null;
        shareCommit = null;
        lockShare(false);
        el('share-form').hidden = true;
        el('share-note').replaceChildren();
        el('share-target').replaceChildren();
        session = null;
        el('home').hidden = true;
        el('auth').hidden = false;
        el('logout').hidden = true;
        el('account-label').textContent = '';
        el('spaces').replaceChildren();
        ['password', 'old-password', 'new-password', 'register-password', 'team-name'].forEach(function (id) { el(id).value = ''; });
        el('remember-me').checked = false;
    }
    function lockIdentity(locked) {
        authBusy = locked;
        el('auth').inert = locked;
        el('home').inert = locked;
        el('logout').disabled = locked;
    }
    function beginIdentity(owner, clear) {
        if (authBusy)
            throw new Error('身份验证正在处理中，请稍候');
        if (clear)
            showAuth();
        else {
            sessionGeneration++;
            refreshGeneration++;
            closeManagement();
            clearShare();
        }
        owner.auth = sessionGeneration;
        owner.management = null;
        owner.share = null;
        lockIdentity(true);
    }
    async function refresh(owner) {
        owner = owner || context();
        var generation = ++refreshGeneration;
        var fresh;
        try {
            fresh = await request('/pkw/session');
        }
        catch (error) {
            // An old unauthorized read must not sign out a newer successful refresh.
            if (!owner.current() || generation !== refreshGeneration)
                return false;
            throw error;
        }
        if (!owner.current() || generation !== refreshGeneration)
            return false;
        if (session && session.username !== fresh.username) {
            showAuth();
            message('登录账号已变化，请重新登录后继续。', true);
            return false;
        }
        session = fresh;
        el('auth').hidden = true;
        el('home').hidden = false;
        el('logout').hidden = false;
        el('account-label').textContent = session.username;
        el('spaces').replaceChildren();
        session.spaces.forEach(function (space) {
            var card = document.createElement('article');
            card.className = 'card space';
            var badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = (space.kind === 'private' ? '私人空间' : '团队共享') + ' · ' + roles[space.role];
            var heading = document.createElement('h2');
            heading.textContent = space.name;
            var desc = document.createElement('p');
            desc.className = 'muted';
            desc.textContent = space.kind === 'private' ? '仅你可以访问。你可以在这里放心保留个人资料。' : space.role === 'viewer' ? '你可以阅读、检索和下载这个团队的资料。' : '与已加入的成员一起整理知识、附件和任务。';
            var row = document.createElement('div');
            row.className = 'row';
            var link = document.createElement('a');
            link.className = 'button primary';
            link.href = '/pkw/spaces/' + space.id;
            link.textContent = '进入空间';
            row.append(link);
            if (space.kind === 'team' && (space.role === 'owner' || space.role === 'admin')) {
                row.append(button('成员与权限', function (operation) { return members(space, operation); }));
            }
            card.append(badge, heading, desc, row);
            el('spaces').append(card);
        });
        return true;
    }
    async function members(space, owner) {
        if (!space || !owner.current())
            return;
        closeManagement();
        owner.management = managementGeneration;
        owner.invitation = null;
        owner.audit = null;
        var list = await manage({ action: 'members', spaceId: space.id });
        if (!owner.current())
            return;
        currentSpace = space;
        el('management').hidden = false;
        el('management-title').textContent = space.name + ' · 成员与权限';
        el('invite-role').querySelector('option[value=admin]').disabled = space.role !== 'owner';
        el('invite-role').value = 'editor';
        list.forEach(function (member) {
            var tr = document.createElement('tr');
            var name = document.createElement('td');
            var role = document.createElement('td');
            var actions = document.createElement('td');
            name.textContent = member.username;
            role.textContent = roles[member.role];
            var row = document.createElement('div');
            row.className = 'row';
            if (member.role !== 'owner' && (space.role === 'owner' || member.role !== 'admin')) {
                var select = document.createElement('select');
                select.setAttribute('aria-label', '更改 ' + member.username + ' 的角色');
                ['viewer', 'editor', 'admin'].forEach(function (value) {
                    if (value === 'admin' && space.role !== 'owner')
                        return;
                    var option = document.createElement('option');
                    option.value = value;
                    option.textContent = roles[value];
                    select.append(option);
                });
                select.value = member.role;
                row.append(select, button('保存角色', async function (operation) {
                    var selectedRole = select.value;
                    await manage({ action: 'setRole', spaceId: space.id, userId: member.id, role: selectedRole });
                    if (!operation.current() || !await refresh(operation))
                        return;
                    await members(session.spaces.find(function (item) { return item.id === space.id; }), operation);
                    message('成员角色已更新', false, operation);
                }, 'management'), button('移除', async function (operation) {
                    if (!confirm('移除 ' + member.username + ' 对此空间的访问权限？他的私人资料不受影响。'))
                        return;
                    await manage({ action: 'setRole', spaceId: space.id, userId: member.id, role: null });
                    if (!operation.current())
                        return;
                    await members(space, operation);
                    message('已移除访问权限', false, operation);
                }, 'management'));
                if (space.role === 'owner')
                    row.append(button('转让所有权', async function (operation) {
                        if (!confirm('将 ' + space.name + ' 的所有权转让给 ' + member.username + '？你将变为管理员。'))
                            return;
                        await manage({ action: 'transfer', spaceId: space.id, userId: member.id });
                        if (!operation.current() || !await refresh(operation))
                            return;
                        await members(session.spaces.find(function (item) { return item.id === space.id; }), operation);
                        message('空间所有权已转让', false, operation);
                    }, 'management'));
            }
            else
                row.textContent = member.role === 'owner' ? '当前所有者' : '仅所有者可管理';
            actions.append(row);
            tr.append(name, role, actions);
            el('members').append(tr);
        });
        if (owner.feedback === feedbackGeneration)
            el('management-title').focus();
    }
    form('login-form', async function (owner) {
        var input = { username: el('username').value, password: el('password').value, rememberMe: el('remember-me').checked === true };
        beginIdentity(owner, true);
        try {
            await request('/pkw/login', input);
            if (!owner.current())
                return;
            if (await refresh(owner))
                returnToRequestedSpace(owner);
        }
        finally {
            lockIdentity(false);
        }
    });
    form('register-form', async function (owner) {
        var input = { token: el('register-token').value.trim(), username: el('register-name').value, password: el('register-password').value };
        beginIdentity(owner, true);
        try {
            await request('/pkw/register', input);
            if (!owner.current())
                return;
            el('username').value = input.username;
            el('register-password').value = '';
            el('register-token').value = '';
            el('register-panel').open = false;
            message('账号已创建，请使用刚设置的密码登录', false, owner);
        }
        finally {
            lockIdentity(false);
        }
        if (owner.current())
            el('password').focus();
    });
    form('team-form', async function (owner) {
        var name = el('team-name').value;
        await manage({ action: 'createTeam', name: name });
        if (!owner.current())
            return;
        if (el('team-name').value === name)
            el('team-name').value = '';
        if (await refresh(owner))
            message('共享空间已创建。进入成员与权限即可邀请同伴。', false, owner);
    });
    form('accept-form', async function (owner) {
        var token = el('accept-token').value.trim();
        await manage({ action: 'accept', token: token });
        if (!owner.current())
            return;
        if (el('accept-token').value.trim() === token)
            el('accept-token').value = '';
        if (await refresh(owner))
            message('已加入团队共享空间', false, owner);
    });
    form('password-form', async function (owner) {
        var input = { action: 'password', previous: el('old-password').value, password: el('new-password').value };
        beginIdentity(owner, false);
        try {
            await manage(input);
            if (!owner.current())
                return;
            showAuth();
            owner.auth = sessionGeneration;
            message('密码已修改，请重新登录', false, owner);
        }
        finally {
            lockIdentity(false);
        }
    });
    action(el('logout'), async function (owner) {
        if (authBusy)
            return;
        // Start with the current token, then immediately remove sensitive projections.
        var pending = manage({ action: 'logout' });
        beginIdentity(owner, true);
        message('正在退出登录…', false, owner);
        try {
            await pending;
            message('已退出登录', false, owner);
        }
        finally {
            lockIdentity(false);
        }
    });
    action(el('close-management'), closeManagement);
    action(el('invite-button'), async function (owner) {
        if (!currentSpace)
            return;
        var space = currentSpace;
        var role = el('invite-role').value;
        clearInvitation();
        owner.invitation = invitationGeneration;
        var invite = await manage({ action: 'invite', spaceId: space.id, role: role });
        if (!owner.current())
            return;
        el('invite-output').querySelector('label').textContent = space.name + ' · ' + roles[role] + ' · 邀请链接（24 小时有效，仅可使用一次）';
        el('invite-link').value = location.origin + '/pkw#invite=' + encodeURIComponent(invite.token);
        el('invite-output').hidden = false;
        if (owner.feedback === feedbackGeneration) {
            el('invite-link').focus();
            el('invite-link').select();
        }
    }, 'management');
    action(el('copy-link'), async function (owner) {
        owner.invitation = invitationGeneration;
        var link = el('invite-link').value;
        try {
            await navigator.clipboard.writeText(link);
            message('邀请链接已复制', false, owner);
        }
        catch (error) {
            if (!owner.current())
                return;
            if (owner.feedback === feedbackGeneration) {
                el('invite-link').focus();
                el('invite-link').select();
            }
            message('请复制已选中的邀请链接', false, owner);
        }
    }, 'management');
    action(el('revoke-button'), async function (owner) {
        if (!currentSpace || !confirm('撤销此空间全部尚未使用的邀请链接？已加入成员不受影响。'))
            return;
        var space = currentSpace;
        clearInvitation();
        owner.invitation = invitationGeneration;
        await manage({ action: 'revokeInvites', spaceId: space.id });
        if (!owner.current())
            return;
        message(space.name + '：未使用的邀请已全部撤销', false, owner);
    }, 'management');
    action(el('audit-button'), async function (owner) {
        if (!currentSpace)
            return;
        var space = currentSpace;
        owner.audit = ++auditGeneration;
        var rows = await manage({ action: 'audit', spaceId: space.id });
        if (!owner.current())
            return;
        el('audit').replaceChildren();
        rows.forEach(function (row) {
            var li = document.createElement('li');
            li.textContent = new Date(row.at).toLocaleString() + ' · ' + row.action + ' · ' + row.actor;
            el('audit').append(li);
        });
        if (!rows.length) {
            var li = document.createElement('li');
            li.textContent = '暂无操作记录';
            el('audit').append(li);
        }
    }, 'management');
    el('share-note').addEventListener('change', clearShare);
    el('share-target').addEventListener('change', clearShare);
    action(el('cancel-share'), function () { if (!shareCommit)
        clearShare(); });
    action(el('load-share-notes'), async function (owner) {
        if (shareCommit)
            return;
        clearShare();
        owner.share = shareGeneration;
        shareSource = null;
        el('share-form').hidden = true;
        el('share-note').replaceChildren();
        el('share-target').replaceChildren();
        var source = session.spaces.find(function (space) { return space.kind === 'private'; });
        var targets = session.spaces.filter(function (space) { return space.kind === 'team' && space.role !== 'viewer'; });
        if (!source || !targets.length)
            throw new Error('请先创建或加入一个有编辑权限的团队空间');
        var notes = await request('/pkw/spaces/' + source.id + '/api', { method: 'listNotes', args: {} }, true);
        if (!owner.current())
            return;
        shareSource = source;
        notes.forEach(function (note) {
            var option = document.createElement('option');
            option.value = note.noteId;
            option.textContent = note.title + ' · ' + note.relativePath;
            el('share-note').append(option);
        });
        targets.forEach(function (space) {
            var option = document.createElement('option');
            option.value = space.id;
            option.textContent = space.name + ' · ' + roles[space.role];
            el('share-target').append(option);
        });
        el('share-form').hidden = !notes.length;
        if (!notes.length)
            message('私人空间还没有可分享的笔记', false, owner);
        else if (owner.feedback === feedbackGeneration)
            el('share-note').focus();
    }, 'share');
    form('share-form', async function (owner) {
        if (shareCommit)
            return;
        if (!shareSource || !el('share-note').value || !el('share-target').value)
            throw new Error('请先选择私人笔记和目标团队');
        var input = { action: 'preview', sourceSpaceId: shareSource.id, targetSpaceId: el('share-target').value, noteId: el('share-note').value };
        clearShare();
        owner.share = shareGeneration;
        var plan = await request('/pkw/share', input, true);
        if (!owner.current())
            return;
        sharePreview = plan;
        el('share-preview-title').textContent = plan.title;
        el('share-scope').textContent = '目标：' + plan.targetName + '。以下正文、笔记属性及列出的附件会成为团队成员可访问的独立副本。';
        el('share-body').textContent = (plan.frontmatter ? plan.frontmatter + '\n' : '') + plan.body;
        plan.attachments.forEach(function (file) {
            var li = document.createElement('li');
            li.textContent = (file.filename || file.attachmentId) + ' · ' + (file.sizeBytes || 0) + ' 字节';
            el('share-attachments').append(li);
        });
        plan.warnings.forEach(function (warning) {
            var li = document.createElement('li');
            li.textContent = warning;
            el('share-warnings').append(li);
        });
        el('share-preview').hidden = false;
        if (owner.feedback === feedbackGeneration)
            el('confirm-share').focus();
    }, 'share');
    action(el('confirm-share'), async function (owner) {
        if (!sharePreview || shareCommit)
            return;
        var plan = sharePreview;
        var commit = { owner: owner, plan: plan };
        shareCommit = commit;
        lockShare(true);
        el('share-result').textContent = '正在复制到 ' + plan.targetName + '。请求已提交，请等待结果；关闭页面不会撤销服务器已接受的复制。';
        try {
            var result = await request('/pkw/share', { action: 'commit', token: plan.token }, true);
            if (!owner.current())
                return;
            clearShare();
            owner.share = shareGeneration;
            if (result.status === 'complete') {
                el('share-result').textContent = '已复制到 ' + plan.targetName + '，私人原稿保留。';
                var link = document.createElement('a');
                link.href = '/pkw/spaces/' + result.targetSpaceId;
                link.textContent = '打开目标团队空间';
                el('share-result').append(document.createTextNode(' '), link);
            }
            else {
                el('share-result').textContent = '复制未完整完成，请勿重复操作。请由服务器管理员核对记录 ' + result.receiptId + '。' + (result.warnings || []).join(' ');
            }
        }
        catch (error) {
            if (owner.current())
                el('share-result').textContent = '尚未确认复制结果。可以使用同一预览重试；系统将按同一个确认凭据核对结果。';
            throw error;
        }
        finally {
            if (shareCommit === commit) {
                shareCommit = null;
                lockShare(false);
            }
        }
    }, 'share');
    var hash = new URLSearchParams(location.hash.slice(1));
    var invite = hash.get('invite');
    if (invite) {
        history.replaceState(null, '', location.pathname);
        el('register-token').value = invite;
        el('accept-token').value = invite;
        el('register-panel').open = true;
    }
    var initialOwner = context();
    el('session-expired-message').hidden = entryParams.get('reason') !== 'session-expired';
    refresh(initialOwner).then(function (ready) {
        if (ready)
            returnToRequestedSpace(initialOwner);
    }).catch(function () {
        if (initialOwner.current() && session)
            showAuth();
    });
})();
</script></body></html>`
}
