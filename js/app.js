/* HTTPto — 网页版 HTTP 终端
 *
 * 移植自 reqcli.py（requests 版），请求层改用 fetch。
 * 命令语法、内置命令、输出格式与原版保持一致。
 */
(function () {
  'use strict';

  var LS = 'httpto_cfg_v1';
  var CONFIG = {
    base_url: 'https://api.github.com',
    user_agent: 'HTTPto/2.0',
    accept: 'application/vnd.github+json',
    token: '',
    timeout: 10
  };
  try {
    var saved = JSON.parse(localStorage.getItem(LS) || '{}');
    Object.keys(CONFIG).forEach(function (k) { if (saved[k] != null) CONFIG[k] = saved[k]; });
  } catch (e) { /* 存档坏了就用默认值，不影响启动 */ }

  function saveCfg() {
    try { localStorage.setItem(LS, JSON.stringify(CONFIG)); } catch (e) {}
  }

  var _history = [];      // 请求历史（history 命令）
  var _cmdHist = [];      // 命令行历史（↑↓ 翻阅）
  var _cmdPos = -1;

  var out = document.getElementById('out');
  var form = document.getElementById('form');
  var cmd = document.getElementById('cmd');
  var metaBase = document.getElementById('metaBase');
  var metaToken = document.getElementById('metaToken');

  // ── 工具 ──
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function hl(s) {                       // 给 JSON 上色
    var e = esc(s).replace(/&quot;/g, '"');
    e = e.replace(/"([^"\\]*(\\.[^"\\]*)*)"(\s*:)/g, '<i class="jk">"$1"</i>$3');
    e = e.replace(/:\s*"([^"\\]*(\\.[^"\\]*)*)"/g, ': <i class="js">"$1"</i>');
    e = e.replace(/:\s*(-?\d+\.?\d*(e[+-]?\d+)?)/gi, ': <i class="jn">$1</i>');
    e = e.replace(/:\s*(true|false|null)/g, ': <i class="jb">$1</i>');
    return e;
  }
  function now() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }
  function print(html, cls) {
    var d = document.createElement('div');
    d.className = 'ln' + (cls ? ' ' + cls : '');
    d.innerHTML = html;
    out.appendChild(d);
    out.scrollTop = out.scrollHeight;
    return d;
  }
  function printRaw(text, cls) { return print(hl(text).replace(/\n/g, '<br>'), cls); }
  function syncMeta() {
    metaBase.textContent = CONFIG.base_url.replace(/^https?:\/\//, '');
    if (CONFIG.token) {
      metaToken.textContent = 'token ' + CONFIG.token.length + ' 位';
      metaToken.classList.add('ok');
    } else {
      metaToken.textContent = 'token 未配置';
      metaToken.classList.remove('ok');
    }
  }

  // ── 请求 ──
  // ★ 浏览器不允许改这几个头（forbidden header），设了也会被静默丢弃。
  //   原版 requests 能设 User-Agent，网页版不行 —— 必须如实告诉用户，不能假装生效。
  var FORBIDDEN = { 'user-agent': 1, host: 1, referer: 1, cookie: 1, origin: 1, 'content-length': 1 };
  function getHeaders() {
    var h = { Accept: CONFIG.accept };
    Object.keys(CONFIG).forEach(function () {});
    if (CONFIG.user_agent && !FORBIDDEN['user-agent']) h['User-Agent'] = CONFIG.user_agent;
    if (CONFIG.token) h['Authorization'] = 'Bearer ' + CONFIG.token;
    return h;
  }

  function doRequest(method, path, body) {
    var url = /^https?:\/\//i.test(path) ? path : CONFIG.base_url + path;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, CONFIG.timeout * 1000);
    var t0 = performance.now();
    var opt = { method: method, headers: getHeaders(), signal: ctrl.signal, credentials: 'omit' };
    if (body != null && method !== 'GET' && method !== 'DELETE') {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(function (r) {
      clearTimeout(timer);
      var ms = (performance.now() - t0) / 1000;
      return r.text().then(function (text) { return { r: r, text: text, ms: ms, url: url }; });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        return { timeout: true, ms: CONFIG.timeout, url: url };
      }
      return { failed: true, msg: String(err && err.message || err), url: url };
    });
  }

  function render(res, method) {
    if (res.failed) {
      print('<span class="err">请求失败: ' + esc(res.msg) + '</span>');
      print('<span class="tip">💡 最常见原因是目标站点不允许跨域（CORS）：浏览器拦下了响应，' +
            '命令没写错。换 api.github.com、httpbin.org 这类支持 CORS 的地址试试。</span>');
      return;
    }
    if (res.timeout) {
      print('<span class="err">请求超时（' + CONFIG.timeout + ' 秒）。可 set timeout 30 放宽。</span>');
      return;
    }
    var r = res.r;
    _history.push({ time: now(), method: method, url: res.url, status: r.status });

    var cls = r.status >= 500 ? 's5' : r.status >= 400 ? 's4' : r.status >= 300 ? 's3' : 's2';
    print('<span class="stat ' + cls + '">HTTP ' + r.status + '</span>' +
          ' <span class="dim">(' + res.ms.toFixed(2) + 's)</span>');
    print('<span class="rule">' + '-'.repeat(50) + '</span>');

    var t = (res.text || '').trim();
    if (!t) {
      print('<span class="dim">(空响应体)</span>', 'body');
      return;
    }
    try {
      var obj = JSON.parse(t);
      var pretty = JSON.stringify(obj, null, 2);
      // 太长就截断，避免一次塞几万行把页面卡死
      if (pretty.length > 6000) {
        pretty = pretty.slice(0, 6000) + '\n… 已截断（共 ' + pretty.length + ' 字符）';
      }
      printRaw(pretty, 'body');
    } catch (e) {
      printRaw(t.length > 3000 ? t.slice(0, 3000) + '\n… 已截断' : t, 'body');
    }
  }

  // ── 命令解析 ──
  function parseInput(raw) {
    raw = raw.trim();
    if (!raw) return null;
    var low = raw.toLowerCase();
    if (low === 'exit') return 'EXIT';
    if (low === 'help' || low === 'h' || low === '?') return 'HELP';
    if (low === 'config') return 'CONFIG';
    if (low === 'apis') return 'APIS';
    if (low === 'fields') return 'FIELDS';
    if (low === 'history') return 'HISTORY';
    if (low.startsWith('set ')) return ['SET', raw.slice(4).trim()];

    // ★ 不能照抄 Python 的 raw.split(" ", 2)：
    //   Python 的 maxsplit=2 切出 3 段，JS 的 split(' ',2) 只给 2 段。
    //   照抄的话 parts[2] 永远是 undefined，POST/PUT/PATCH 的请求体会被静默丢掉
    //   —— 请求照发、状态码照回，只是 body 没送出去，极难察觉。
    //   所以这里手动按前两个空格切，其余整段都算 body（body 内允许空格）。
    var i1 = raw.indexOf(' ');
    var method = (i1 < 0 ? raw : raw.slice(0, i1)).toUpperCase();
    var valid = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    if (valid.indexOf(method) < 0) {
      return '未知命令: ' + (i1 < 0 ? raw : raw.slice(0, i1)) +
             '\n支持的请求方法: ' + valid.join(', ') +
             '\n内置命令: help, config, apis, fields, history, set, exit';
    }
    var rest = i1 < 0 ? '' : raw.slice(i1 + 1).trim();
    var i2 = rest.indexOf(' ');
    var path = i2 < 0 ? rest : rest.slice(0, i2);
    var bodyStr = i2 < 0 ? null : rest.slice(i2 + 1).trim();
    if (!path) path = '/';
    var body = null;
    if (bodyStr && ['POST', 'PUT', 'PATCH'].indexOf(method) >= 0) {
      try { body = JSON.parse(bodyStr); }
      catch (e) { return 'JSON 解析失败: ' + e.message + '\n你输入的: ' + bodyStr; }
    }
    return ['REQUEST', method, path, body];
  }

  function handleSet(arg) {
    var parts = arg.split(' ', 1);
    var i = arg.indexOf(' ');
    if (i < 0) return '用法: set <key> <value>\n可用 key: base_url, token, timeout, user_agent, accept';
    var key = arg.slice(0, i).toLowerCase();
    var value = arg.slice(i + 1).trim();

    if (key === 'base_url') {
      if (!/^https?:/i.test(value)) value = 'https://' + value;
      value = value.replace(/\/+$/, '');
      CONFIG.base_url = value; saveCfg(); syncMeta();
      return '✅ base_url 已设为: ' + value;
    }
    if (key === 'token') {
      CONFIG.token = value; saveCfg(); syncMeta();
      return '✅ token 已更新（长度 ' + value.length + ' 字符）\n' +
             '⚠️ 网页版把 token 存在这台设备的浏览器里（localStorage）。公用设备用完记得 set token 空掉。';
    }
    if (key === 'timeout') {
      var n = parseInt(value, 10);
      if (!n || n < 1) return '❌ timeout 必须是正整数（秒）';
      CONFIG.timeout = n; saveCfg();
      return '✅ timeout 已设为 ' + n + ' 秒';
    }
    if (key === 'user_agent') {
      CONFIG.user_agent = value; saveCfg();
      return '⚠️ user_agent 已记录为: ' + value + '\n' +
             '   但浏览器禁止网页修改 User-Agent（forbidden header），实际请求不会带上它。\n' +
             '   这是浏览器安全策略，不是 HTTPto 的问题 —— 想要自定义 UA 请用命令行版。';
    }
    if (key === 'accept') {
      CONFIG.accept = value; saveCfg();
      return '✅ accept 已设为: ' + value;
    }
    return '❌ 未知配置项: ' + key + '\n可用: base_url, token, timeout, user_agent, accept';
  }

  // ── 内置命令输出 ──
  function showHelp() {
    return [
      'HTTPto v2.0 — 网页版 HTTP 终端',
      '',
      '📌 请求语法:',
      '  METHOD /path [body_json]',
      '  GET    /users/Cool-zimo',
      '  POST   /user/repos {"name":"test","auto_init":true}',
      '  PATCH  /repos/{o}/{r} {"private":true}',
      '  DELETE /repos/{o}/{r}',
      '  💡 path 写完整 URL 也可以，会直接用它而不拼 base_url：',
      '     GET https://httpbin.org/get',
      '',
      '📌 配置命令:',
      '  set base_url https://api.github.com',
      '  set token ghp_xxxxxxxxxxxx',
      '  set timeout 30',
      '  config              查看当前配置',
      '',
      '📌 信息命令:',
      '  help      帮助        apis    API 速查表',
      '  fields    字段/状态码  history 请求历史',
      '  exit      清屏（网页版不会真的退出）',
      '',
      '📌 快捷键: ↑↓ 翻阅历史命令 · Ctrl+L 清屏',
      '',
      '📌 当前 base_url: ' + CONFIG.base_url,
      '📌 Token: ' + (CONFIG.token ? '已配置（' + CONFIG.token.length + ' 位）' : '未配置'),
      '📌 Timeout: ' + CONFIG.timeout + 's'
    ].join('\n');
  }

  function showConfig() {
    var lines = ['当前配置', '─'.repeat(45)];
    ['base_url', 'user_agent', 'accept', 'token', 'timeout'].forEach(function (k) {
      var v = k === 'token'
        ? (CONFIG[k] ? '******（长度 ' + CONFIG[k].length + '）' : '(空)')
        : String(CONFIG[k]);
      lines.push('  ' + (k + '            ').slice(0, 12) + ' = ' + v);
    });
    lines.push('');
    lines.push('  修改: set <key> <value>');
    lines.push('  配置自动存在这台设备上，刷新不丢。');
    return lines.join('\n');
  }

  var APIS = [
    ['GET', '/user', '当前用户（需 token）'],
    ['GET', '/users/{username}', '查用户'],
    ['GET', '/users/{u}/repos', '用户仓库列表'],
    ['GET', '/users/{u}/followers', '粉丝列表'],
    ['GET', '/repos/{o}/{r}', '查仓库'],
    ['POST', '/user/repos', '建仓库（需 token）'],
    ['PUT', '/repos/{o}/{r}', '改仓库（全量）'],
    ['PATCH', '/repos/{o}/{r}', '改仓库（部分）'],
    ['DELETE', '/repos/{o}/{r}', '删仓库（需 token）'],
    ['GET', '/repos/{o}/{r}/branches', '分支列表'],
    ['GET', '/repos/{o}/{r}/contents/{path}', '文件/目录'],
    ['GET', '/repos/{o}/{r}/issues', 'issue 列表'],
    ['POST', '/repos/{o}/{r}/issues', '建 issue（需 token）'],
    ['PATCH', '/repos/{o}/{r}/issues/{n}', '改 issue'],
    ['POST', '/repos/{o}/{r}/forks', 'Fork（需 token）'],
    ['GET', '/repos/{o}/{r}/pulls', 'PR 列表'],
    ['POST', '/repos/{o}/{r}/pulls', '建 PR（需 token）'],
    ['GET', '/search/repositories?q=python+stars:%3E1000', '搜仓库'],
    ['GET', '/search/users?q=Cool-zimo', '搜用户'],
    ['GET', '/rate_limit', '查限流'],
    ['GET', '/meta', 'API 元信息'],
    ['GET', '/emojis', 'emoji 列表']
  ];

  function showApis() {
    return ['GitHub API 速查表（点一行可直接填入输入框）', '─'.repeat(45), '']
      .concat(APIS.map(function (a) {
        return '  ' + (a[0] + '     ').slice(0, 7) + ' ' + (a[1] + '                                  ').slice(0, 38) + ' ' + a[2];
      }))
      .concat(['', '💡 path 自动拼接到 base_url 后面', '💡 当前: ' + CONFIG.base_url])
      .join('\n');
  }

  function showFields() {
    return [
      '请求字段 + 状态码速查', '─'.repeat(45), '',
      '┌─ Headers ────────────────────────────┐',
      '│  Accept          期望返回格式          │',
      '│  Authorization   Bearer {token} 认证   │',
      '│  Content-Type    自动设为 JSON         │',
      '│  ⚠️ User-Agent / Cookie / Referer 等   │',
      '│     浏览器禁止网页修改，设了也不生效    │',
      '└──────────────────────────────────────┘',
      '',
      '┌─ 状态码 ──────────────────────────────┐',
      '│  200 OK          成功读取              │',
      '│  201 Created     成功创建（POST）      │',
      '│  204 No Content  成功无返回（DELETE）  │',
      '│  304 Not Modified 未修改（缓存）       │',
      '│  400 Bad Request 参数错误              │',
      '│  401 Unauthorized token 无效/未提供    │',
      '│  403 Forbidden   限流或无权限          │',
      '│  404 Not Found   路径写错              │',
      '│  409 Conflict    冲突                 │',
      '│  422 Unprocessable 参数校验失败        │',
      '└──────────────────────────────────────┘',
      '',
      '┌─ 网页版特别注意 ──────────────────────┐',
      '│  CORS：目标站点必须允许跨域，否则浏览器│',
      '│  会拦下响应。报错时多半不是命令写错了。 │',
      '│  GitHub API 与 httpbin.org 都支持 CORS │',
      '└──────────────────────────────────────┘'
    ].join('\n');
  }

  function showHistory() {
    if (!_history.length) return '（暂无请求历史）\n发几个请求后再来看吧~';
    var lines = ['请求历史', '─'.repeat(45), '',
      '  ' + ('时间' + '        ').slice(0, 8) + ('方法' + '      ').slice(0, 8) + '状态  URL'];
    _history.slice(-20).forEach(function (h) {
      lines.push('  ' + (h.time + '        ').slice(0, 8) +
                 (h.method + '      ').slice(0, 8) + h.status + '   ' + h.url);
    });
    lines.push('');
    lines.push('  共 ' + _history.length + ' 条记录');
    return lines.join('\n');
  }

  // ── 执行 ──
  function run(raw) {
    if (!raw.trim()) return;
    _cmdHist.push(raw);
    if (_cmdHist.length > 200) _cmdHist.shift();
    _cmdPos = -1;

    print('<span class="echo"><span class="m">&gt;&gt;&gt;</span> ' + esc(raw) + '</span>');

    var res = parseInput(raw);
    if (res === 'EXIT') { out.innerHTML = ''; banner(); return; }
    if (res === 'HELP') { printRaw(showHelp(), 'body'); return; }
    if (res === 'CONFIG') { printRaw(showConfig(), 'body'); return; }
    if (res === 'APIS') { renderApis(); return; }
    if (res === 'FIELDS') { printRaw(showFields(), 'body'); return; }
    if (res === 'HISTORY') { printRaw(showHistory(), 'body'); return; }
    if (typeof res === 'string') { print('<span class="err">' + esc(res) + '</span>'); return; }

    if (res[0] === 'SET') { printRaw(handleSet(res[1]), 'body'); return; }

    // REQUEST
    var method = res[1], path = res[2], body = res[3];
    var full = /^https?:\/\//i.test(path) ? path : CONFIG.base_url + path;
    print('<span class="dim">→ ' + method + ' ' + esc(full) + '</span>');
    if (body) print('<span class="dim">  Body: ' + esc(JSON.stringify(body)) + '</span>');
    doRequest(method, path, body).then(function (r) { render(r, method); });
  }

  // 速查表单独渲染：每行可点，点了直接填进输入框
  function renderApis() {
    printRaw(showApis(), 'body');
    // 用一张可点的表覆盖在纯文本下面，更好用
    var box = document.createElement('div');
    box.className = 'body';
    APIS.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'cmdline';
      row.textContent = '▸ ' + a[0] + ' ' + a[1] + '  — ' + a[2];
      row.addEventListener('click', function () {
        cmd.value = a[0] + ' ' + a[1];
        cmd.focus();
      });
      box.appendChild(row);
    });
    out.appendChild(box);
    out.scrollTop = out.scrollHeight;
  }

  function banner() {
    var b = [
      '  ┌────────────────────────────────────────────┐',
      '  │   HTTPto v2.0 · 任意链接 HTTP 终端          │',
      '  │   GET / POST / PUT / PATCH / DELETE         │',
      '  └────────────────────────────────────────────┘',
      '',
      '  输入 help 看帮助，apis 看速查表。',
      '  现在试试：GET /users/Cool-zimo',
      ''
    ].join('\n');
    print('<span class="banner">' + esc(b) + '</span>');
  }

  // ── 事件 ──
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = cmd.value;
    cmd.value = '';
    run(v);
  });

  cmd.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!_cmdHist.length) return;
      if (_cmdPos < 0) _cmdPos = _cmdHist.length - 1;
      else if (_cmdPos > 0) _cmdPos--;
      cmd.value = _cmdHist[_cmdPos];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (_cmdPos < 0) return;
      if (_cmdPos < _cmdHist.length - 1) { _cmdPos++; cmd.value = _cmdHist[_cmdPos]; }
      else { _cmdPos = -1; cmd.value = ''; }
    } else if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      out.innerHTML = '';
    }
  });

  document.querySelectorAll('.chip[data-cmd]').forEach(function (b) {
    b.addEventListener('click', function () {
      run(b.getAttribute('data-cmd'));
      cmd.focus();
    });
  });

  banner();
  syncMeta();
  cmd.focus();
})();
