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
      return r.text().then(function (text) { return { r: r, text: text, ms: ms, url: url, dropped: dropped,
        sentBody: body === undefined ? null : body, sentExtra: extraHeaders || null }; });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        return { timeout: true, ms: CONFIG.timeout, url: url };
      }
      return { failed: true, msg: String(err && err.message || err), url: url,
               extraKeys: extraHeaders ? Object.keys(extraHeaders) : null };
    });
  }

  function render(res, method, flags) {
    flags = flags || {};
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
    // ★ 记下 body 和 headers，replay 才能原样重发 POST/PUT/PATCH。
    //   只记 method+url 的话，重发一个建仓库的 POST 会变成空 body，直接 422。
    _history.push({ time: now(), method: method, url: res.url, status: r.status,
                    body: res.sentBody || null, headers: res.sentExtra || null });

    // 局部 headers 里若含浏览器禁改的头，必须说出来 —— 静默丢弃会让人以为生效了
    if (res.dropped && res.dropped.length) {
      print('<span class="tip">⚠️ 以下请求头被浏览器忽略（网页禁止修改）: ' +
            esc(res.dropped.join(', ')) + '</span>');
    }

    var cls = r.status >= 500 ? 's5' : r.status >= 400 ? 's4' : r.status >= 300 ? 's3' : 's2';

    // ── -status：只打印状态码，不要 body ──
    if (flags.status) {
      print('<span class="stat ' + cls + '">HTTP ' + r.status + '</span>' +
            ' <span class="dim">(' + res.ms.toFixed(2) + 's)</span>');
      return;
    }

    // ── -raw：只打印响应体，去掉状态和分隔线（方便复制/管道处理）──
    if (flags.raw) {
      var rt = (res.text || '').trim();
      printRaw(rt.length > 6000 ? rt.slice(0, 6000) + '\n… 已截断' : rt, 'body');
      return;
    }

    // ── 什么 flag 都没有时才打印完整头 ──
    if (!flags.quiet) {
      print('<span class="stat ' + cls + '">HTTP ' + r.status + '</span>' +
            ' <span class="dim">(' + res.ms.toFixed(2) + 's)</span>');
      print('<span class="rule">' + '-'.repeat(50) + '</span>');
    }

    var t = (res.text || '').trim();
    if (!t) {
      print('<span class="dim">(空响应体)</span>', 'body');
      return;
    }

    // ── -save=名字：把响应存起来，供 diff 对比 ──
    if (flags.save) {
      var sv = null;
      try { sv = JSON.parse(t); } catch (e) { sv = t; }
      _saved[flags.save] = { status: r.status, body: sv, at: now(), url: res.url };
      print('<span class="tip">💾 已保存为 ' + esc(flags.save) + '（HTTP ' + r.status +
            '）· 用 diff ' + esc(flags.save) + ' 另一份 对比</span>');
    }

    // ── -output=文件 / > 文件：把响应 body 下载下来 ──
    if (flags.output) {
      if (download(flags.output, t)) {
        print('<span class="tip">💾 响应已写入文件: ' + esc(flags.output) +
              '（' + t.length + ' 字符）· 浏览器会下载到本地</span>');
      } else {
        print('<span class="err">写文件失败，浏览器拒绝了下载</span>');
      }
      return;
    }

    var obj = null, parsed = false;
    try { obj = JSON.parse(t); parsed = true; } catch (e) {}

    // ── -only=a,b,c：只打印指定字段 ──
    if (flags.only) {
      if (!parsed) { print('<span class="err">响应不是 JSON，没法用 -only 挑字段</span>'); return; }
      var pk = pickFields(obj, flags.only);
      var pl2 = [];
      if (pk.miss.length) pl2.push('⚠ 这些字段没找到: ' + pk.miss.join(', '));
      pl2.push(JSON.stringify(pk.res, null, 2));
      printRaw(pl2.join('\n'), 'body');
      return;
    }

    if (parsed) {
      var pretty = JSON.stringify(obj, null, 2);
      // 太长就截断，避免一次塞几万行把页面卡死
      if (pretty.length > 6000) {
        pretty = pretty.slice(0, 6000) + '\n… 已截断（共 ' + pretty.length + ' 字符）';
      }
      printRaw(pretty, 'body');
    } else {
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

  // 所有 flag 的定义：name → {val: 是否取值, kind: 值类型}
  var FLAGS = {
    'n':        { val: false },          // 免引号
    'noquote':  { val: false, alias: 'n' },
    'raw':      { val: false },          // 只打印响应体
    'status':   { val: false },          // 只打印状态码
    'silent':   { val: false },          // 不发请求，只预览
    'headers':  { val: true, kind: 'json' },
    'params':   { val: true, kind: 'json' },
    'output':   { val: true, kind: 'str' },
    'only':     { val: true, kind: 'str' },
    'save':     { val: true, kind: 'str' },
    'timeout':  { val: true, kind: 'num' },
    'delay':    { val: true, kind: 'num' }
  };

  function splitFlags(text) {
    var last = findBodyEnd(text);
    var bodyPart = text, flagPart = '';
    if (last !== -1 && last < text.length - 1) {
      // 配对的闭合符后面还有内容，那一段才可能是 flags
      bodyPart = text.slice(0, last + 1);
      flagPart = text.slice(last + 1);
    } else if (last === -1) {
      // ★ findBodyEnd 返回 -1 = 没有以括号开头的合法 body，整段都是 flags。
      //   不能额外要求「整段不含 {」—— -params={q:python} 的值里就有 {，
      //   加了那个条件会把 GET /x -params={...} 整段当 body，params 静默失效。
      bodyPart = '';
      flagPart = text;
    }
    var flags = { n: false, headers: undefined, params: undefined, output: undefined,
                  only: undefined, save: undefined, timeout: undefined, delay: undefined,
                  raw: false, status: false, silent: false, unknown: [] };
    var toks = flagPart.split(/\s+/).filter(Boolean);
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.charAt(0) !== '-') { flags.unknown.push(t); continue; }
      var name = t.slice(1), val = null, hasEq = false;
      var eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); hasEq = true; }
      var key = name.toLowerCase();
      var def = FLAGS[key];
      if (!def) { flags.unknown.push(t); continue; }

      if (def.val) {                                  // 需要取值的 flag
        if (!hasEq) {
          if (i + 1 < toks.length && toks[i + 1].charAt(0) !== '-') { val = toks[++i]; }
          else return { err: '❌ -' + key + ' 需要值（如 -' + key + '=xxx）' };
        }
        if (key === 'headers') {
          if (String(val).toLowerCase() === 'config') { flags.headers = undefined; continue; }
          var hv = null;
          try { hv = JSON.parse(val); }
          catch (e) {
            try { hv = JSON.parse(autoQuote(val)); }
            catch (e2) { return { err: 'headers 解析失败: ' + e2.message + '\n你输入的: ' + val }; }
          }
          flags.headers = hv; continue;
        }
        if (key === 'params') {
          var pv = null;
          try { pv = JSON.parse(val); }
          catch (e) {
            try { pv = JSON.parse(autoQuote(val)); }   // -params={q:python,sort:stars} 免引号
            catch (e2) { return { err: 'params 解析失败: ' + e2.message + '\n你输入的: ' + val }; }
          }
          flags.params = pv; continue;
        }
        if (key === 'timeout' || key === 'delay') {
          var nv = parseInt(val, 10);
          // delay 允许 0（尽快连发），timeout 至少要 1 秒
          if (isNaN(nv) || nv < 0 || (key === 'timeout' && nv < 1)) {
            return { err: '❌ -' + key + ' 必须是' + (key === 'delay' ? '非负' : '正') + '整数，你给的: ' + val };
          }
          flags[key] = nv; continue;
        }
        flags[key] = val; continue;
      }
      flags[(def.alias || key)] = true;                // 布尔型 flag
    }
    return { bodyPart: bodyPart, flags: flags };
  }

  // ── 预设环境（use 命令）──
  var PRESETS = {
    github: { base_url: 'https://api.github.com', accept: 'application/vnd.github+json' },
    gitee:  { base_url: 'https://gitee.com/api/v5', accept: 'application/json' },
    httpbin:{ base_url: 'https://httpbin.org', accept: 'application/json' },
    jsonph: { base_url: 'https://jsonplaceholder.typicode.com', accept: 'application/json' },
    local:  { base_url: 'http://127.0.0.1:8000', accept: 'application/json' }
  };

  // ── 快捷别名（! 命令）──
  // {0} {1} 依次替换后面的参数
  var ALIASES = {
    'user':   'GET /users/{0}',
    'me':     'GET /user',
    'repo':   'GET /repos/{0}',
    'repos':  'GET /user/repos',
    'search': 'GET /search/repositories -params={q:{0}}',
    'issues': 'GET /repos/{0}/issues',
    'rate':   'GET /rate_limit',
    'stars':  'GET /users/{0}/starred',
    'followers': 'GET /users/{0}/followers'
  };

  // ── 响应存档（-save= / diff）──
  var _saved = {};
  // ── 上一条原始响应，供 pipe {0} 引用 ──
  var _lastObj = null;
  // ── 上一条完整请求（replay 用：需记录 body 与 headers 才能重发）──
  var _lastReq = null;

  // 按 -only=a,b,c 从对象里挑字段，支持 a.b 形式取嵌套
  function pickFields(obj, spec) {
    var keys = String(spec).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var res = {}, hit = [];
    keys.forEach(function (k) {
      var cur = obj, okAll = true, parts = k.split('.');
      for (var i = 0; i < parts.length; i++) {
        if (cur == null || typeof cur !== 'object') { okAll = false; break; }
        cur = cur[parts[i]];
      }
      if (okAll && cur !== undefined) { res[k] = cur; hit.push(k); }
    });
    return { res: res, hit: hit, miss: keys.filter(function (k) { return hit.indexOf(k) < 0; }) };
  }

  // 把响应文本写成本地文件下载
  function download(name, text) {
    try {
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return true;
    } catch (e) { return false; }
  }

  // 生成等价 curl 命令
  function toCurl(method, url, body, headers) {
    var parts = ['curl -X ' + method, "'" + url + "'"];
    Object.keys(headers || {}).forEach(function (k) {
      parts.push("-H '" + k + ': ' + headers[k] + "'");
    });
    if (body != null) parts.push("-d '" + JSON.stringify(body) + "'");
    return parts.join(' \\\n  ');
  }

  // 把请求里的 {0} {1}… 替换成上一条响应的字段
  // 用法：GET /repos/{0.full_name}/issues —— 取上一条响应里的 full_name
  function subst(str) {
    if (!str || _lastObj == null) return str;
    return String(str).replace(/\{(\d+)((?:\.[A-Za-z0-9_]+)*)\}/g, function (m, idx, path) {
      var v = Array.isArray(_lastObj) ? _lastObj[parseInt(idx, 10)] : _lastObj;
      if (v == null) return m;
      var ps = path ? path.slice(1).split('.') : [];
      for (var i = 0; i < ps.length; i++) {
        if (v == null) return m;
        v = v[ps[i]];
      }
      return v == null ? m : String(v);
    });
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
    if (low === 'presets') return ['PRESETS'];
    if (low.startsWith('set ')) return ['SET', raw.slice(4).trim()];

    // ── ! 快捷别名 ──
    if (raw.charAt(0) === '!') {
      var ap = raw.slice(1).split(/\s+/).filter(Boolean);
      var an = (ap[0] || '').toLowerCase();
      var tpl = ALIASES[an];
      if (!tpl) {
        return '未知别名: !' + an + '\n可用: ' + Object.keys(ALIASES).map(function (k) { return '!' + k; }).join(', ');
      }
      var exp = tpl.replace(/\{(\d+)\}/g, function (m, d) {
        var v = ap[1 + parseInt(d, 10)];
        return v === undefined ? m : v;
      });
      if (/\{0\}/.test(exp)) return '❌ !' + an + ' 需要一个参数，如：!' + an + ' Cool-zimo';
      return ['ALIAS', exp, raw];
    }

    // ── replay N ──
    if (low.startsWith('replay ')) {
      var rn = parseInt(raw.slice(7).trim(), 10);
      if (!rn) return '用法: replay N（N 是 history 里的序号，从 1 开始）';
      return ['REPLAY', rn];
    }

    // ── repeat N <命令> ──
    if (low.startsWith('repeat ')) {
      var rp = raw.slice(7).trim().split(/\s+/);
      var cnt = parseInt(rp[0], 10);
      if (!cnt || cnt < 1) return '用法: repeat N <命令>，如 repeat 5 GET /rate_limit';
      if (cnt > 50) return '❌ 一次最多重复 50 次（防误触把限流打满），你给了 ' + cnt;
      return ['REPEAT', cnt, rp.slice(1).join(' ')];
    }

    // ── use <preset> ──
    if (low.startsWith('use ')) {
      var un = raw.slice(4).trim().toLowerCase();
      if (!PRESETS[un]) {
        return '未知预设: ' + un + '\n可用: ' + Object.keys(PRESETS).join(', ') + '\n输入 presets 看详情';
      }
      return ['USE', un];
    }

    // ── diff a b ──
    if (low.startsWith('diff ')) {
      var dn = raw.slice(5).trim().split(/\s+/).filter(Boolean);
      if (dn.length !== 2) return '用法: diff a b（两个都是 -save= 存下来的名字）';
      return ['DIFF', dn[0], dn[1]];
    }
    if (low === 'diff') {
      var ks = Object.keys(_saved);
      return ks.length ? '已保存的响应: ' + ks.join(', ') + '\n用法: diff a b'
                       : '还没有保存过响应。用 -save=名字 保存，如：\n  GET /users/Cool-zimo -save=a';
    }

    // ── gen <命令> ──
    if (low.startsWith('gen ')) return ['GEN', raw.slice(4).trim()];

    // ── mock <status> <json> ──
    if (low.startsWith('mock ')) {
      var mk = raw.slice(5).trim().split(/\s+/);
      var st = parseInt(mk[0], 10);
      if (!st) return '用法: mock 201 {"id":1,"name":"fake"}';
      return ['MOCK', st, mk.slice(1).join(' ')];
    }

    // ── 管道：命令1 | 命令2 ──
    // 只在最外层切一次，body 里的 | 不算
    if (raw.indexOf('|') >= 0) {
      var segs = raw.split('|');
      if (segs.length > 2) return '❌ 最多支持两段管道（a | b），你写了 ' + segs.length + ' 段';
      var left = segs[0].trim(), right = segs[1].trim();
      if (!left || !right) return '❌ 管道两边都得有命令，如：GET /users/Cool-zimo | GET /users/{0.login}/repos';
      return ['PIPE', left, right];
    }

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
        // ★ 未闭合的 body（{"bad json}）会被当成 unknown flag 报"未知 flag"，
        //   但用户其实是在写 body 只是写错了 —— 要报 JSON 解析失败才对得上。
        var maybe = sp.flags.unknown.join(' ');
        if (/^\s*[[{]/.test(maybe)) {
          try { JSON.parse(maybe); }
          catch (e2) {
            return 'JSON 解析失败: ' + e2.message + '\n解析到的内容:\n' + maybe;
          }
        }
        return '未知 flag: ' + sp.flags.unknown.join(' ') +
               '\n支持的: -n / -noquote（自动加引号）、-headers={...} 或 -headers config';
      }
      if (noQuote) bodyStr = autoQuote(bodyStr);
      var parsed;
      try { parsed = JSON.parse(bodyStr); }
      catch (e) { return 'JSON 解析失败: ' + e.message + '\n解析到的内容:\n' + bodyStr; }
      return ['REQUEST', method, path, parsed, extraHeaders, sp.flags];
    }
    // ★ GET/DELETE 也要带 flags，否则 -save= / -only= / -raw / -status 这类
    //   不需要 body 的 flag 在没有 body 时全部失效 —— 静默失效，极难察觉。
    //   （上面的分支只覆盖 POST/PUT/PATCH，sp 是那里的局部变量，这里必须重新解析）
    if (bodyStr) {
      var sf = splitFlags(bodyStr);
      if (sf.err) return sf.err;
      if (sf.flags.unknown.length) {
        var maybe2 = sf.flags.unknown.join(' ');
        if (/^\s*[[{]/.test(maybe2)) {
          try { JSON.parse(maybe2); }
          catch (e3) {
            return 'JSON 解析失败: ' + e3.message + '\n解析到的内容:\n' + maybe2;
          }
        }
        return '未知 flag: ' + sf.flags.unknown.join(' ') +
               '\n支持的: -params= / -output= / -raw / -status / -only= / -silent / -timeout= / -save= / -headers=';
      }
      return ['REQUEST', method, path, null, sf.flags.headers, sf.flags];
    }
    return ['REQUEST', method, path, null, null, null];
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
      'HTTPto v3.0 — 网页版 HTTP 终端',
      '',
      '📌 请求语法:',
      '  METHOD /path [body] [flags]',
      '  GET    /users/Cool-zimo',
      '  POST   /user/repos {"name":"test","auto_init":true}',
      '  PATCH  /repos/{o}/{r} {"private":true}',
      '  DELETE /repos/{o}/{r}',
      '  💡 path 写完整 URL 也可以，会直接用它而不拼 base_url：',
      '     GET https://httpbin.org/get',
      '',
      '📌 Flags:',
      '  -params={...}     GET 查询参数，自动拼到 URL 后面',
      '      GET /search/repositories -params={q:python,sort:stars}',
      '  -output=file      响应存成文件（也可写  > file ）',
      '  -raw              只打印响应体，不要状态码和分隔线',
      '  -status           只打印状态码，不要 body',
      '  -only=a,b,c       只显示指定字段（支持 a.b 取嵌套）',
      '  -silent           不发请求，只预览最终 URL + 头 + body',
      '  -timeout=N        只这次改超时，不动全局',
      '  -save=名字        保存响应，供 diff 对比',
      '  -n / -noquote     key 和 value 免打引号，自动补上',
      '      POST /user/repos {name:test,private:true} -n',
      '  -headers={...}    局部请求头，只影响这一次',
      '  -headers=config   用回全局请求头（默认）',
      '  ⚠️ 跨域时只有目标站点放行的头才有效（见 fields），',
      '     否则会触发预检失败，请求发不出去 —— 与命令行版不同。',
      '',
      '📌 命令:',
      '  !user Cool-zimo  快捷别名（!me !repo !search !rate !issues…）',
      '  replay N         重发历史第 N 条（会带上原来的 body）',
      '  repeat N <命令>   重复 N 次，间隔用 -delay= 调（默认 1s）',
      '  use github       切换预设环境（github/gitee/httpbin/jsonph/local）',
      '  presets          列出所有预设',
      '  diff a b         对比两份 -save= 保存的响应',
      '  gen GET /user    生成等价 curl 命令',
      '  mock 201 {"id":1} 模拟响应，不真发请求',
      '  A | B            管道：B 里用 {0} / {0.login} 引用 A 的响应',
      '      GET /users/Cool-zimo | GET /users/{0.login}/repos',
      '',
      '📌 快捷键:',
      '  Tab 补全  ↑↓ 翻历史  Ctrl+L 清屏  Esc 取消多行',
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

    // ── `> 文件名` 重定向：转成 -output= ──
    // ★ 必须要求 > 是独立 token（前面有空格）。
    //   `q:python+stars>1000` 里的 > 紧贴字符，是搜索条件的一部分，
    //   无脑找最后一个 > 会把搜索条件切掉一半，而且不报错。
    var m = raw.match(/\s+>\s*([^\s>]+)\s*$/);
    if (m) raw = raw.slice(0, m.index).trim() + ' -output=' + m[1];

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

    // ── ! 别名：展开后回显一次，让人知道它变成了什么 ──
    if (res[0] === 'ALIAS') {
      print('<span class="dim">  ↳ ' + esc(res[1]) + '</span>');
      var ar = parseInput(res[1]);
      if (typeof ar === 'string') { print('<span class="err">' + esc(ar) + '</span>'); return; }
      if (ar[0] === 'REQUEST') { fire(ar[1], ar[2], ar[3], ar[4], ar[5]); return; }
      return;
    }

    // ── presets ──
    if (res[0] === 'PRESETS') {
      var pl = ['可用预设（use <名字> 切换）', '─'.repeat(45), ''];
      Object.keys(PRESETS).forEach(function (k) {
        pl.push('  ' + (k + '          ').slice(0, 10) + PRESETS[k].base_url);
      });
      pl.push(''); pl.push('  当前: ' + CONFIG.base_url);
      printRaw(pl.join('\n'), 'body'); return;
    }

    // ── use ──
    if (res[0] === 'USE') {
      var p = PRESETS[res[1]];
      CONFIG.base_url = p.base_url; CONFIG.accept = p.accept;
      saveCfg(); syncMeta();
      printRaw('✅ 已切换到预设 ' + res[1] + '\n   base_url = ' + p.base_url +
               '\n   accept   = ' + p.accept + '\n   token 沿用不变', 'body');
      return;
    }

    // ── replay N ──
    if (res[0] === 'REPLAY') {
      if (_history.length < res[1]) {
        print('<span class="err">历史里只有 ' + _history.length + ' 条，没有第 ' + res[1] + ' 条</span>'); return;
      }
      var h = _history[res[1] - 1];
      // 只记了 method/url，重发时从 url 反推 path
      var rel = h.url;
      if (rel.indexOf(CONFIG.base_url) === 0) rel = rel.slice(CONFIG.base_url.length);
      print('<span class="dim">  ↳ 重发 ' + h.method + ' ' + esc(h.url) +
            (h.body ? '（带原 body）' : '') + '</span>');
      fire(h.method, rel, h.body, h.headers, null);
      return;
    }

    // ── repeat N <命令> ──
    if (res[0] === 'REPEAT') {
      var n = res[1], sub = res[2];
      var sr = parseInput(sub);
      if (typeof sr === 'string') { print('<span class="err">' + esc(sr) + '</span>'); return; }
      if (sr[0] !== 'REQUEST') { print('<span class="err">repeat 后面只能跟请求命令</span>'); return; }
      var gap = (sr[5] && sr[5].delay) ? sr[5].delay : 1;
      print('<span class="dim">→ 重复 ' + n + ' 次，间隔 ' + gap + 's：' + esc(sub) + '</span>');
      var k = 0;
      (function next() {
        if (k >= n) { printRaw('✅ 完成 ' + n + ' 次', 'body'); return; }
        k++;
        print('<span class="dim">  [' + k + '/' + n + ']</span>');
        doRequest(sr[1], sr[2], sr[3], sr[4]).then(function (r) {
          render(r, sr[1]);
          // 浏览器里没有阻塞式 sleep，只能用 setTimeout 排队；最后一轮不再等
          if (k < n) setTimeout(next, gap * 1000);
          else printRaw('✅ 完成 ' + n + ' 次', 'body');
        });
      })();
      return;
    }

    // ── diff a b ──
    if (res[0] === 'DIFF') { doDiff(res[1], res[2]); return; }

    // ── gen <命令> ──
    if (res[0] === 'GEN') {
      var gr = parseInput(res[1]);
      if (typeof gr === 'string') { print('<span class="err">' + esc(gr) + '</span>'); return; }
      if (gr[0] !== 'REQUEST') { print('<span class="err">gen 后面只能跟请求命令</span>'); return; }
      var gurl = /^https?:\/\//i.test(gr[2]) ? gr[2] : CONFIG.base_url + gr[2];
      var gh = getHeaders();
      if (gr[4]) Object.keys(gr[4]).forEach(function (kk) {
        if (!FORBIDDEN[kk.toLowerCase()]) gh[kk] = gr[4][kk];
      });
      if (gr[3] != null) gh['Content-Type'] = 'application/json';
      printRaw('💡 等价 curl 命令（可复制到服务器跑）\n\n' + toCurl(gr[1], gurl, gr[3], gh), 'body');
      return;
    }

    // ── mock ──
    if (res[0] === 'MOCK') {
      var mo = null;
      try { mo = res[2] ? JSON.parse(autoQuote(res[2])) : {}; }
      catch (e) { print('<span class="err">mock 的 JSON 解析失败: ' + esc(e.message) + '</span>'); return; }
      printRaw('🧪 模拟响应（没有真的发请求）\n\nHTTP ' + res[1] + '\n' +
               '-'.repeat(50) + '\n' + JSON.stringify(mo, null, 2), 'body');
      return;
    }

    // ── 管道：先跑左边，把响应存进 _lastObj，再展开右边 ──
    if (res[0] === 'PIPE') { doPipe(res[1], res[2]); return; }

    // REQUEST
    fire(res[1], res[2], res[3], res[4], res[5]);
  }

  // 管道执行：左边请求的结果供右边 {0} / {0.field} 引用
  function doPipe(left, right) {
    var lr = parseInput(left);
    if (typeof lr === 'string') { print('<span class="err">' + esc(lr) + '</span>'); return; }
    if (lr[0] !== 'REQUEST') { print('<span class="err">管道左边只能是请求命令</span>'); return; }
    print('<span class="dim">▶ 第一段: ' + esc(left) + '</span>');
    doRequest(lr[1], lr[2], lr[3], lr[4]).then(function (r) {
      if (r.failed || r.timeout) { render(r, lr[1]); return; }
      _lastObj = null;
      try { _lastObj = JSON.parse(r.text); } catch (e) { _lastObj = null; }
      if (_lastObj == null) {
        render(r, lr[1]);
        print('<span class="err">第一段返回的不是 JSON，没法给第二段提供变量</span>');
        return;
      }
      // 第一段用 -raw/-status 静默掉 body，避免刷屏；只留个提示
      print('<span class="stat s2">HTTP ' + r.r.status + '</span> <span class="dim">(' +
            r.ms.toFixed(2) + 's) 第一段完成，结果已存入 {0}</span>');
      var expanded = subst(right);
      print('<span class="dim">▶ 第二段: ' + esc(expanded) + '</span>');
      var rr = parseInput(expanded);
      if (typeof rr === 'string') { print('<span class="err">' + esc(rr) + '</span>'); return; }
      if (rr[0] !== 'REQUEST') { print('<span class="err">管道右边只能是请求命令</span>'); return; }
      fire(rr[1], rr[2], rr[3], rr[4], rr[5]);
    });
  }

  // 两份保存的响应做逐行对比，差异高亮
  function doDiff(a, b) {
    var A = _saved[a], B = _saved[b];
    if (!A || !B) {
      var miss = [!A ? a : null, !B ? b : null].filter(Boolean);
      print('<span class="err">没找到保存的响应: ' + esc(miss.join(', ')) +
            '\n已保存的: ' + (Object.keys(_saved).join(', ') || '（无）') + '</span>');
      return;
    }
    var ta = JSON.stringify(A.body, null, 2).split('\n');
    var tb = JSON.stringify(B.body, null, 2).split('\n');
    var lns = ['对比 ' + a + ' （HTTP ' + A.status + '） ↔ ' + b + ' （HTTP ' + B.status + '）',
               '─'.repeat(45), ''];
    if (A.status !== B.status) {
      lns.push('⚠ 状态码不同: ' + A.status + ' → ' + B.status);
      lns.push('');
    }
    var max = Math.max(ta.length, tb.length), diffs = 0;
    for (var i = 0; i < max; i++) {
      var x = ta[i], y = tb[i];
      if (x === y) { lns.push('  ' + (x === undefined ? '' : x)); continue; }
      diffs++;
      if (x !== undefined) lns.push('- ' + x);
      if (y !== undefined) lns.push('+ ' + y);
    }
    lns.push('');
    lns.push(diffs ? '共 ' + diffs + ' 处差异（- 是 ' + a + '，+ 是 ' + b + '）' : '✅ 两份响应完全一致');
    printRaw(lns.join('\n'), 'body');
    // 差异行再单独上色，纯文本里也能一眼看到
    var box = document.createElement('div');
    box.className = 'body';
    var lastLines = out.querySelectorAll('.ln.body');
    var target = lastLines[lastLines.length - 1];
    if (target) {
      target.innerHTML = target.innerHTML
        .replace(/^- (.*)$/gm, '<span class="dl">- $1</span>')
        .replace(/^\+ (.*)$/gm, '<span class="da">+ $1</span>');
    }
  }

  // 续行模式收尾：把整段 body 重新走一遍解析（这样 -n / -headers 也能用）
  function finishRequest(method, path, bodyText) {
    var full = method + ' ' + path + ' ' + bodyText;
    var res = parseInput(full);
    if (typeof res === 'string') { print('<span class="err">' + esc(res) + '</span>'); return; }
    if (!res || res[0] !== 'REQUEST') { print('<span class="err">解析失败</span>'); return; }
    fire(res[1], res[2], res[3], res[4], res[5]);
  }

  function fire(method, path, body, extraHeaders, flags) {
    flags = flags || {};
    var full = /^https?:\/\//i.test(path) ? path : CONFIG.base_url + path;

    // params：拼到 URL 后面（GET 搜索/分页靠它）
    if (flags.params && Object.keys(flags.params).length) {
      var qs = Object.keys(flags.params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(flags.params[k]);
      }).join('&');
      full += (full.indexOf('?') >= 0 ? '&' : '?') + qs;
      path = full;
    }

    var h = getHeaders();
    if (extraHeaders) Object.keys(extraHeaders).forEach(function (k) {
      if (!FORBIDDEN[k.toLowerCase()]) h[k] = extraHeaders[k];
    });

    print('<span class="dim">→ ' + method + ' ' + esc(full) + '</span>');
    if (body) print('<span class="dim">  Body: ' + esc(JSON.stringify(body)) + '</span>');
    if (extraHeaders) print('<span class="dim">  Extra-Headers: ' + esc(JSON.stringify(extraHeaders)) + '</span>');

    // ── -silent：只预览，不发请求 ──
    if (flags.silent) {
      printRaw('🔇 静默模式（没有真的发请求）\n\n' + method + ' ' + full + '\n' +
               '-'.repeat(50) + '\nHeaders:\n' + JSON.stringify(h, null, 2) +
               (body ? '\n\nBody:\n' + JSON.stringify(body, null, 2) : ''), 'body');
      return;
    }

    // -timeout= 只覆盖这一次，不动全局配置
    if (flags.timeout) {
      var old = CONFIG.timeout;
      CONFIG.timeout = flags.timeout;
      doRequest(method, path, body, extraHeaders).then(function (r) {
        CONFIG.timeout = old;
        render(r, method, flags);
      });
      return;
    }
    doRequest(method, path, body, extraHeaders).then(function (r) { render(r, method, flags); });
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
      '  │   HTTPto v3.0 · 任意链接 HTTP 终端          │',
      '  │   GET / POST / PUT / PATCH / DELETE         │',
      '  │  管道 · 别名 · 预设 · diff · curl · Tab 补全 │',
      '  └────────────────────────────────────────────┘',
      '',
      '  输入 help 看帮助，apis 看速查表。',
      '  现在试试：GET /users/Cool-zimo -only=login',
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
    } else if (e.key === 'Tab') {
      e.preventDefault();
      complete();
    }
  });

  // ── Tab 补全 ──
  // 浏览器里没有 readline，得自己实现。
  // 候选 = 内置命令 + 请求方法 + !别名 + use 预设 + 速查表里的路径。
  function candidates(frag) {
    var fc = frag.trimLeft();
    // 以 ! 开头 → 补别名
    if (fc.charAt(0) === '!') {
      var an = fc.slice(1);
      return Object.keys(ALIASES).filter(function (k) { return k.indexOf(an) === 0; })
                   .map(function (k) { return '!' + k; });
    }
    // 第二个词且首词是 use → 补预设名
    var parts = fc.split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === 'use') {
      return Object.keys(PRESETS).filter(function (k) { return k.indexOf(parts[1].toLowerCase()) === 0; })
                   .map(function (k) { return 'use ' + k; });
    }
    // 第一个词 → 命令 + 方法
    if (parts.length <= 1) {
      var w = (parts[0] || '').toUpperCase();
      return CMDS.concat(METHODS).filter(function (c) { return c.indexOf(w) === 0; });
    }
    // 第二个词是路径 → 补速查表里的路径
    if (parts.length === 2 && METHODS.indexOf(parts[0].toUpperCase()) >= 0) {
      var pfx = parts[1];
      var seen = {}, list = [];
      APIS.forEach(function (a) {
        if (a[1].indexOf(pfx) === 0 && !seen[a[1]]) { seen[a[1]] = 1; list.push(a[1]); }
      });
      return list.map(function (p) { return parts[0].toUpperCase() + ' ' + p; });
    }
    return [];
  }

  var CMDS = ['help', 'config', 'apis', 'fields', 'history', 'presets', 'set',
              'exit', 'use', 'replay', 'repeat', 'diff', 'gen', 'mock'];
  var METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

  function complete() {
    var v = cmd.value;
    var list = candidates(v);
    if (!list.length) {
      print('<span class="dim">（没有可补全的）</span>');
      return;
    }
    if (list.length === 1) {
      cmd.value = list[0] + (list[0].indexOf(' ') >= 0 ? '' : ' ');
      return;
    }
    // 多个候选：先补到公共前缀，再把候选列出来
    var common = list[0];
    list.forEach(function (s) {
      var i = 0;
      while (i < common.length && i < s.length && common[i] === s[i]) i++;
      common = common.slice(0, i);
    });
    if (common.length > v.trimLeft().length) cmd.value = common;
    print('<span class="dim">  ' + esc(list.slice(0, 12).join('   ')) +
          (list.length > 12 ? '  …共 ' + list.length + ' 个' : '') + '</span>');
  }

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
