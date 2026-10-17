/* HTTPto — 网页版 HTTP 终端
 *
 * 移植自 reqcli.py（requests 版），请求层改用 fetch。
 * 命令语法、内置命令、输出格式与原版保持一致。
 */
(function () {
  'use strict';

  var LS = 'httpto_cfg_v1';
  var LSLOG = 'httpto_log_v2';   // 上次会话的输出记录
  var LOGLIMIT = 200 * 1024;     // 存档上限，超出就从最早的开始丢
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
    scheduleSave();
    return d;
  }

  // ── 会话存档 ──
  // 每次输出后防抖写入，刷新页面自动恢复。
  // 写失败（配额满 / 隐私模式）一律静默忽略 —— 留不住记录也不能影响使用。
  var _saveTimer = null;
  var _noSave = false;      // 启动横幅属于初始状态，不该被当成"上次记录"存进去
  function scheduleSave() {
    if (_noSave) return;
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveLog, 400);
  }
  function saveLog() {
    try {
      // ★ 存之前先摘掉"上次保留的记录"那条提示，否则每刷新一次就多一条，越攒越多
      var tips = out.querySelectorAll('.restore-tip');
      var saved = [];
      Array.prototype.forEach.call(tips, function (t) { saved.push([t, t.nextSibling]); t.remove(); });
      // 超限时从最早的开始丢，别让 localStorage 撑爆
      while (out.innerHTML.length > LOGLIMIT && out.children.length > 20) {
        out.removeChild(out.firstChild);
      }
      localStorage.setItem(LSLOG, JSON.stringify({
        html: out.innerHTML,
        history: _history.slice(-50),
        ts: Date.now()
      }));
      // 提示只是不在存档里，页面上还得留着
      saved.forEach(function (pair) { out.insertBefore(pair[0], pair[1]); });
    } catch (e) {}
  }
  function clearLog() {
    // ★ 必须同时取消待触发的写入：否则清屏后那次防抖写回又把旧内容存回来了
    clearTimeout(_saveTimer);
    try { localStorage.removeItem(LSLOG); } catch (e) {}
  }
  function restoreLog() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(LSLOG) || 'null'); } catch (e) {}
    if (!s || !s.html) return false;
    out.innerHTML = s.html;
    if (Object.prototype.toString.call(s.history) === '[object Array]') _history = s.history;
    var d = new Date(s.ts || Date.now());
    var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var tip = document.createElement('div');
    tip.className = 'ln body restore-tip';
    tip.innerHTML = '<span class="dim">── 以上是上次保留的记录（' + hh +
      '）· 输入 exit 清屏，或点顶栏「清屏」──</span>';
    out.appendChild(tip);
    out.scrollTop = out.scrollHeight;
    return true;
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

  function doRequest(method, path, body, extraHeaders) {
    var url = /^https?:\/\//i.test(path) ? path : CONFIG.base_url + path;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, CONFIG.timeout * 1000);
    var t0 = performance.now();
    var h = getHeaders();
    var dropped = [];
    if (extraHeaders) {
      Object.keys(extraHeaders).forEach(function (k) {
        if (FORBIDDEN[k.toLowerCase()]) { dropped.push(k); return; }   // 浏览器不让改，如实告诉用户
        h[k] = extraHeaders[k];
      });
    }
    var opt = { method: method, headers: h, signal: ctrl.signal, credentials: 'omit' };
    if (body != null && method !== 'GET' && method !== 'DELETE') {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(url, opt).then(function (r) {
      clearTimeout(timer);
      var ms = (performance.now() - t0) / 1000;
      return r.text().then(function (text) { return { r: r, text: text, ms: ms, url: url, dropped: dropped }; });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        return { timeout: true, ms: CONFIG.timeout, url: url };
      }
      return { failed: true, msg: String(err && err.message || err), url: url,
               extraKeys: extraHeaders ? Object.keys(extraHeaders) : null };
    });
  }

  function render(res, method) {
    if (res.failed) {
      print('<span class="err">请求失败: ' + esc(res.msg) + '</span>');
      // ★ 带自定义头时，多半是预检（OPTIONS）没过：
      //   加任何非白名单的头都会触发预检，服务器不点头，浏览器直接拦掉请求。
      //   不说清这点，用户会以为是自己命令写错了。
      if (res.extraKeys && res.extraKeys.length) {
        print('<span class="tip">💡 这次带了自定义头 ' + esc(res.extraKeys.join(', ')) +
              '，而浏览器对跨域请求的自定义头要先发一次预检。\n' +
              '   目标站点没在 Access-Control-Allow-Headers 里放行它，请求就被拦了 —— 不是命令写错。\n' +
              '   输入 fields 可以看 GitHub 放行的头有哪些。</span>');
      } else {
        print('<span class="tip">💡 最常见原因是目标站点不允许跨域（CORS）：浏览器拦下了响应，' +
              '命令没写错。换 api.github.com、httpbin.org 这类支持 CORS 的地址试试。</span>');
      }
      return;
    }
    if (res.timeout) {
      print('<span class="err">请求超时（' + CONFIG.timeout + ' 秒）。可 set timeout 30 放宽。</span>');
      return;
    }
    var r = res.r;
    _history.push({ time: now(), method: method, url: res.url, status: r.status });

    // 局部 headers 里若含浏览器禁改的头，必须说出来 —— 静默丢弃会让人以为生效了
    if (res.dropped && res.dropped.length) {
      print('<span class="tip">⚠️ 以下请求头被浏览器忽略（网页禁止修改）: ' +
            esc(res.dropped.join(', ')) + '</span>');
    }

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

  // ── -n 自动加引号 ──
  // 把 {name:test, age:18, private:true} 转成合法 JSON。
  // 逐字符扫描，遇到裸词就补引号；字符串/数字/布尔/结构字符原样透出。
  function autoQuote(s) {
    var out = '', i = 0, n = s.length;
    while (i < n) {
      var c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { out += c; i++; continue; }
      if (c === '"' || c === "'") {                 // 已有引号：原样搬，统一成双引号
        out += '"'; i++;
        while (i < n && s[i] !== c) {
          if (s[i] === '\\' && i + 1 < n) { out += s[i] + s[i + 1]; i += 2; }
          else { out += s[i]; i++; }
        }
        if (i < n) { out += '"'; i++; }
        continue;
      }
      if ('{}[]:,'.indexOf(c) >= 0) { out += c; i++; continue; }
      if ((c >= '0' && c <= '9') || c === '-') {    // 数字（含负数、小数、指数）
        var num = '';
        while (i < n && /[0-9.\-+eE]/.test(s[i])) { num += s[i]; i++; }
        out += num; continue;
      }
      var word = '';                                 // 字母串
      while (i < n && /[A-Za-z_]/.test(s[i])) { word += s[i]; i++; }
      if (word === 'true' || word === 'false' || word === 'null') { out += word; continue; }
      // 既不是纯字母（比如含中文、点、@），继续吃成裸词
      var bare = word;
      while (i < n && ' ,:{}[]"\'\n\r\t'.indexOf(s[i]) < 0) { bare += s[i]; i++; }
      if (bare) out += '"' + bare.replace(/"/g, '\\"') + '"';
    }
    return out;
  }

  function isClosed(s) {
    var a = 0, b = 0, i;
    for (i = 0; i < s.length; i++) {
      if (s[i] === '{') a++; else if (s[i] === '}') a--;
      else if (s[i] === '[') b++; else if (s[i] === ']') b--;
    }
    return a === 0 && b === 0;
  }

  // ── flags 解析 ──
  // 只认 -n / -noquote / -headers=... / -headers <值>，其余原样留在 body 里。
  //
  // ★ 不能用 lastIndexOf('}') 找 body 结尾 —— 原版 Python 的 rfind("}") 就栽在这：
  //   -headers={User-Agent:x} 里那个 } 在更右边，于是 rfind 找到的是 headers 自己的 }，
  //   结果 flagPart 为空、-headers 完全不生效，还会把整段当 JSON 报"解析失败"。
  //   正确做法是从 body 的第一个括号起做配对扫描，找到与它配对的那个闭合符。
  function findBodyEnd(s) {
    var start = -1, i;
    for (i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '{' || c === '[') { start = i; break; }
      if (c !== ' ' && c !== '\t' && c !== '\n') return -1;   // 开头不是括号 → 没有 JSON body
    }
    if (start < 0) return -1;
    var depth = 0, inStr = false, q = '';
    for (i = start; i < s.length; i++) {
      var ch = s[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === q) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; q = ch; continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth <= 0) return i;                              // 与起始括号配对的那个
      }
    }
    return -1;                                                  // 没闭合
  }

  function splitFlags(text) {
    var last = findBodyEnd(text);
    var bodyPart = text, flagPart = '';
    if (last !== -1 && last < text.length - 1) {
      // 配对的闭合符后面还有内容，那一段才可能是 flags
      bodyPart = text.slice(0, last + 1);
      flagPart = text.slice(last + 1);
    } else if (last === -1 && !/[\[{]/.test(text)) {
      // 整段都不含括号：没有 body，整段都当 flags（如 POST /x -n）
      bodyPart = '';
      flagPart = text;
    }
    var flags = { n: false, headers: undefined, unknown: [] };
    var toks = flagPart.split(/\s+/).filter(Boolean);
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.charAt(0) !== '-') { flags.unknown.push(t); continue; }
      var name = t.slice(1), val = null, hasEq = false;
      var eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); hasEq = true; }
      name = name.toLowerCase();
      if (name === 'n' || name === 'noquote') { flags.n = true; continue; }
      if (name === 'headers') {
        if (!hasEq) {                              // -headers <下一个 token>
          if (i + 1 < toks.length && toks[i + 1].charAt(0) !== '-') { val = toks[++i]; }
          else return { err: '❌ -headers 需要值（如 -headers={Accept:xxx} 或 -headers config）' };
        }
        if (String(val).toLowerCase() === 'config') { flags.headers = undefined; continue; }
        var hv = null;
        try { hv = JSON.parse(val); }
        catch (e) {
          try { hv = JSON.parse(autoQuote(val)); }
          catch (e2) { return { err: 'headers 解析失败: ' + e2.message + '\n你输入的: ' + val }; }
        }
        flags.headers = hv; continue;
      }
      flags.unknown.push(t);
    }
    return { bodyPart: bodyPart, flags: flags };
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

    var extraHeaders = null, noQuote = false;
    if (bodyStr && ['POST', 'PUT', 'PATCH'].indexOf(method) >= 0) {
      var sp = splitFlags(bodyStr);
      if (sp.err) return sp.err;
      bodyStr = sp.bodyPart;
      noQuote = sp.flags.n;
      extraHeaders = sp.flags.headers;
      if (sp.flags.unknown.length) {
        return '未知 flag: ' + sp.flags.unknown.join(' ') +
               '\n支持的: -n / -noquote（自动加引号）、-headers={...} 或 -headers config';
      }
      if (noQuote) bodyStr = autoQuote(bodyStr);
      var parsed;
      try { parsed = JSON.parse(bodyStr); }
      catch (e) { return 'JSON 解析失败: ' + e.message + '\n解析到的内容:\n' + bodyStr; }
      return ['REQUEST', method, path, parsed, extraHeaders];
    }
    return ['REQUEST', method, path, null, extraHeaders];
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
      '  METHOD /path [body] [-n] [-headers={...}]',
      '  GET    /users/Cool-zimo',
      '  POST   /user/repos {"name":"test","auto_init":true}',
      '  PATCH  /repos/{o}/{r} {"private":true}',
      '  DELETE /repos/{o}/{r}',
      '  💡 path 写完整 URL 也可以，会直接用它而不拼 base_url：',
      '     GET https://httpbin.org/get',
      '',
      '📌 Flags:',
      '  -n / -noquote     key 和 value 免打引号，自动补上',
      '      POST /user/repos {name:test,private:true} -n',
      '  -headers={...}    局部请求头，只影响这一次',
      '  -headers=config   用回全局请求头（默认）',
      '  ⚠️ 跨域时只有目标站点放行的头才有效（见 fields），',
      '     否则会触发预检失败，请求发不出去 —— 与命令行版不同。',
      '',
      '📌 多行 JSON:',
      '  POST /user/repos {          ← 括号没闭合就进续行模式',
      '  ... name:test,              ← 提示符变成 ... ，接着敲',
      '  ... private:true',
      '  ... } -n                    ← 闭合后自动发送',
      '  中途输入 cancel 或按 Esc 放弃',
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
      '📌 记录保留: 会话输出自动存在这台设备上，刷新/关掉再开都还在。',
      '             输入 exit 或点顶栏「清屏」才会清空。',
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
      '┌─ Flags ────────────────────────────────┐',
      '│  -n            免打引号，自动补上      │',
      '│  -headers={}   局部请求头，仅当次有效  │',
      '└──────────────────────────────────────┘',
      '',
      '┌─ GitHub 放行的自定义头（实测预检结果）──┐',
      '│  Authorization  Content-Type  Accept   │',
      '│  If-Match  If-None-Match               │',
      '│  If-Modified-Since  If-Unmodified-Since│',
      '│  X-GitHub-OTP  X-Requested-With        │',
      '│  GraphQL-Features  X-GitHub-Api-Version│',
      '│  ⚠️ 除此之外的头（如 X-Test）会触发预检 │',
      '│     失败，请求根本发不出去             │',
      '└──────────────────────────────────────┘',
      '',
      '┌─ 网页版特别注意 ──────────────────────┐',
      '│  CORS：目标站点必须允许跨域，否则浏览器│',
      '│  会拦下响应。报错时多半不是命令写错了。 │',
      '│  GitHub API 与 httpbin.org 都支持 CORS │',
      '│  另外 User-Agent / Cookie / Referer 等│',
      '│  浏览器禁止修改，会在输出里明确标出    │',
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
  // 网页版没有真正的多行输入框：body 未闭合时进入「续行模式」，
  // 提示符变成 ... ，继续敲下一行，闭合后自动发送。
  var _cont = null;   // {buf, method, path}

  function setContMode(on) {
    var pr = document.querySelector('.prompt');
    if (pr) pr.textContent = on ? '...' : '>>>';
    var f = document.getElementById('form');
    if (f) f.classList.toggle('cont', !!on);
    cmd.placeholder = on ? '继续输入，闭合 } 或 ] 后自动发送（输入 cancel 放弃）'
                         : 'GET /user    试试 help';
    var c = document.getElementById('btnCancel');
    if (c) c.style.display = on ? '' : 'none';
  }

  function cancelCont() {
    _cont = null;
    setContMode(false);
    print('<span class="dim">（已取消多行输入）</span>');
  }

  function run(raw) {
    raw = raw.trim();

    // ── 续行模式：先把这一行并进缓冲 ──
    if (_cont) {
      if (raw.toLowerCase() === 'cancel') { cancelCont(); return; }
      _cont.buf += '\n' + raw;
      print('<span class="echo"><span class="m">...</span> ' + esc(raw) + '</span>');
      if (!isClosed(_cont.buf)) return;          // 还没闭合，继续等
      var fin = _cont; _cont = null;
      setContMode(false);
      finishRequest(fin.method, fin.path, fin.buf);
      return;
    }

    if (!raw) return;
    _cmdHist.push(raw);
    if (_cmdHist.length > 200) _cmdHist.shift();
    _cmdPos = -1;

    // ★ 回显时把 token 打码：这条内容会被存进会话存档，不能让明文 token 落到磁盘/记录里。
    var echo = raw.replace(/^(set\s+token\s+)(\S+)/i, function (m, a, v) {
      return a + '******（' + v.length + ' 位）';
    });
    print('<span class="echo"><span class="m">&gt;&gt;&gt;</span> ' + esc(echo) + '</span>');

    // ── 判断是否要进入续行模式 ──
    // 只看命令尾部那个没闭合的 { 或 [，且必须是 POST/PUT/PATCH。
    var i1 = raw.indexOf(' ');
    var m0 = (i1 < 0 ? raw : raw.slice(0, i1)).toUpperCase();
    if (['POST', 'PUT', 'PATCH'].indexOf(m0) >= 0) {
      var rest = i1 < 0 ? '' : raw.slice(i1 + 1).trim();
      var i2 = rest.indexOf(' ');
      var p0 = i2 < 0 ? rest : rest.slice(0, i2);
      var b0 = i2 < 0 ? null : rest.slice(i2 + 1).trim();
      if (b0 && /^\s*[[{]/.test(b0) && !isClosed(b0)) {
        _cont = { buf: b0, method: m0, path: p0 || '/' };
        setContMode(true);
        print('<span class="tip">（多行模式）继续输入，闭合后自动发送；输入 cancel 放弃</span>');
        return;
      }
    }

    var res = parseInput(raw);
    if (res === 'EXIT') { clearLog(); out.innerHTML = ''; banner(); return; }
    if (res === 'HELP') { printRaw(showHelp(), 'body'); return; }
    if (res === 'CONFIG') { printRaw(showConfig(), 'body'); return; }
    if (res === 'APIS') { renderApis(); return; }
    if (res === 'FIELDS') { printRaw(showFields(), 'body'); return; }
    if (res === 'HISTORY') { printRaw(showHistory(), 'body'); return; }
    if (typeof res === 'string') { print('<span class="err">' + esc(res) + '</span>'); return; }

    if (res[0] === 'SET') { printRaw(handleSet(res[1]), 'body'); return; }

    // REQUEST
    fire(res[1], res[2], res[3], res[4]);
  }

  // 续行模式收尾：把整段 body 重新走一遍解析（这样 -n / -headers 也能用）
  function finishRequest(method, path, bodyText) {
    var full = method + ' ' + path + ' ' + bodyText;
    var res = parseInput(full);
    if (typeof res === 'string') { print('<span class="err">' + esc(res) + '</span>'); return; }
    if (!res || res[0] !== 'REQUEST') { print('<span class="err">解析失败</span>'); return; }
    fire(res[1], res[2], res[3], res[4]);
  }

  function fire(method, path, body, extraHeaders) {
    var full = /^https?:\/\//i.test(path) ? path : CONFIG.base_url + path;
    print('<span class="dim">→ ' + method + ' ' + esc(full) + '</span>');
    if (body) print('<span class="dim">  Body: ' + esc(JSON.stringify(body)) + '</span>');
    if (extraHeaders) print('<span class="dim">  Extra-Headers: ' + esc(JSON.stringify(extraHeaders)) + '</span>');
    doRequest(method, path, body, extraHeaders).then(function (r) { render(r, method); });
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
    // 横幅是初始状态，不进存档：否则"清屏"后再刷新，又会冒出"上次保留的记录"
    _noSave = true;
    try {
      drawBanner();
    } finally {
      _noSave = false;
    }
  }
  function drawBanner() {
    var b = [
      '  ┌────────────────────────────────────────────┐',
      '  │   HTTPto v2.2 · 任意链接 HTTP 终端          │',
      '  │   GET / POST / PUT / PATCH / DELETE         │',
      '  │   -n 免引号 · -headers 局部头 · 多行 JSON   │',
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
    if (e.key === 'Escape') {
      if (_cont) { e.preventDefault(); cancelCont(); }
      return;
    }
    if (_cont) return;                 // 续行模式下不接管 ↑↓，避免把半截 JSON 翻没了
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
      clearLog();
      out.innerHTML = '';
    }
  });

  document.querySelectorAll('.chip[data-cmd]').forEach(function (b) {
    b.addEventListener('click', function () {
      run(b.getAttribute('data-cmd'));
      cmd.focus();
    });
  });

  var btnClear = document.getElementById('btnClear');
  if (btnClear) {
    btnClear.addEventListener('click', function () {
      clearLog();
      out.innerHTML = '';
      banner();
      cmd.focus();
    });
  }

  var btnCancel = document.getElementById('btnCancel');
  if (btnCancel) {
    btnCancel.style.display = 'none';
    btnCancel.addEventListener('click', function () { cancelCont(); cmd.focus(); });
  }

  banner();
  restoreLog();
  syncMeta();
  cmd.focus();
})();
