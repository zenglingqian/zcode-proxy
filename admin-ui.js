// admin-ui.js — 管理台页面（内嵌单页 HTML，无外部资源）
'use strict';

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZCode 反向代理 · 管理台</title>
<style>
  :root { --bg:#f5f7fa; --card:#fff; --line:#e5e9f0; --txt:#24292f; --sub:#57606a; --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; --acc:#0969da; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:"Microsoft YaHei",system-ui,sans-serif; background:var(--bg); color:var(--txt); }
  .wrap { max-width:880px; margin:0 auto; padding:24px 16px 60px; }
  h1 { font-size:20px; margin:8px 0 2px; }
  .sub { color:var(--sub); font-size:13px; margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:14px; }
  .card h2 { font-size:15px; margin:0 0 10px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .pill { display:inline-block; padding:2px 10px; border-radius:99px; font-size:12px; font-weight:600; }
  .pill.ok { background:#dafbe1; color:var(--ok); }
  .pill.bad { background:#ffebe9; color:var(--bad); }
  .pill.warn { background:#fff8c5; color:var(--warn); }
  .kv { font-size:13px; color:var(--sub); line-height:1.9; word-break:break-all; }
  .kv b { color:var(--txt); }
  button { font:inherit; border:1px solid var(--line); background:#fff; border-radius:8px; padding:7px 14px; cursor:pointer; }
  button:hover { border-color:var(--acc); color:var(--acc); }
  button.primary { background:var(--acc); border-color:var(--acc); color:#fff; }
  button.primary:hover { opacity:.9; color:#fff; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--sub); font-weight:600; }
  code { background:#f0f3f7; padding:1px 6px; border-radius:5px; font-size:12px; }
  .msg { font-size:13px; margin-top:8px; color:var(--sub); white-space:pre-wrap; word-break:break-all; }
  a { color:var(--acc); word-break:break-all; }
</style>
</head>
<body>
<div class="wrap">
  <h1>ZCode 反向代理 · 管理台</h1>
  <div class="sub">把 ZCode 的完整 agent 能力通过 OpenAI 兼容 API 提供给其他软件 · <a href="/health">/health</a> · <a href="/v1/models">/v1/models</a></div>

  <div class="card">
    <h2>运行状态</h2>
    <div class="kv" id="status">加载中…</div>
  </div>

  <div class="card">
    <h2>登录凭据</h2>
    <div class="kv" id="cred">加载中…</div>
    <div class="row" style="margin-top:10px" id="loginBtns">
      <button class="primary" onclick="startLogin('zai')">登录国际 Z.AI 账号</button>
      <button class="primary" onclick="startLogin('bigmodel')">登录国内 BigModel 账号</button>
      <button onclick="cancelLogin()">取消</button>
    </div>
    <div class="msg" id="loginMsg"></div>
  </div>

  <div class="card">
    <h2>连通测试（真实调用一次 agent）</h2>
    <div class="row"><button onclick="test()" id="testBtn">发送测试请求</button><span class="msg" id="testMsg" style="margin:0"></span></div>
    <div class="msg" id="testOut"></div>
  </div>

  <div class="card">
    <h2>模型列表</h2>
    <table id="models"><thead><tr><th>对外模型名</th><th>账号体系</th><th>真实模型</th></tr></thead><tbody></tbody></table>
  </div>

  <div class="card">
    <h2>客户端接入</h2>
    <div class="kv">
      Base URL：<code id="baseUrl"></code><br>
      API Key：config.json 的 <code>apiKey</code>（留空 = 不鉴权，客户端随意填）<br>
      多轮记忆：请求头 <code>X-Zcode-Session-Id</code> 带上响应返回的会话 ID
    </div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
function pill(ok, okTxt, badTxt) { return ok ? '<span class="pill ok">'+okTxt+'</span>' : '<span class="pill bad">'+badTxt+'</span>'; }

async function refresh() {
  try {
    const s = await (await fetch('/admin/status')).json();
    $('status').innerHTML =
      pill(true,'服务运行中','服务异常') + ' 端口 <b>'+s.port+'</b>　' +
      (s.engineAlive ? '<span class="pill ok">引擎运行中</span>' : '<span class="pill warn">引擎待启动</span>') +
      '<br>ZCode 程序：<b>'+(s.zcodePaths ? s.zcodePaths.zcodeExe : '<span style="color:#cf222e">未找到（请检查 ZCode 桌面版安装）</span>')+'</b>' +
      '<br>数据目录：<b>'+s.dataDir+'</b>';
    $('baseUrl').textContent = location.origin + '/v1';

    const c = s.credential;
    const fam = {zai:'国际 Z.AI', bigmodel:'国内 BigModel'};
    if (c.hasJwt) {
      $('cred').innerHTML = pill(true,'已连接','已连接') + ' 登录体系：<b>'+(fam[c.activeProvider]||c.activeProvider||'未知')+'</b><br>凭据文件：<b>'+c.file+'</b>' +
        '<div class="msg">凭据正常。若模型请求报 401，说明 JWT 已过期——重新点上方登录即可恢复。</div>';
    } else {
      $('cred').innerHTML = pill(false,'未登录','未登录') + ' 未找到有效凭据，无法调用模型。<br>凭据文件位置：<b>'+c.file+'</b>' +
        '<div class="msg">请点击上方按钮登录：浏览器会自动打开授权页面，完成授权后这里会自动变为「已连接」。</div>';
    }

    const tb = $('models').querySelector('tbody');
    tb.innerHTML = s.models.map(m => '<tr><td><code>'+m.id+'</code></td><td>'+m.providerId+'</td><td>'+m.modelId+(m.reasoningLevel?'（思考:'+m.reasoningLevel+'）':'')+'</td></tr>').join('');
  } catch (e) { $('status').textContent = '无法获取状态：' + e.message; }
}

async function startLogin(family) {
  setLoginButtons(false);
  try {
    const r = await (await fetch('/admin/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({family})})).json();
    if (!r.ok) { $('loginMsg').textContent = '发起失败：' + r.error; setLoginButtons(true); return; }
    pollLogin();
  } catch (e) { $('loginMsg').textContent = '请求失败：' + e.message; setLoginButtons(true); }
}
async function cancelLogin() {
  await fetch('/admin/login/cancel', {method:'POST'});
  $('loginMsg').textContent = '已取消。';
  setLoginButtons(true);
}
function setLoginButtons(on) {
  document.querySelectorAll('#loginBtns button').forEach(b => b.disabled = !on);
}
let polling = null;
function pollLogin() {
  if (polling) return;
  polling = setInterval(async () => {
    try {
      const s = await (await fetch('/admin/login/status')).json();
      if (s.url && s.state === 'waiting') {
        $('loginMsg').innerHTML = '⏳ ' + s.message + '<br>授权链接（若浏览器未自动打开请<a target="_blank" href="'+s.url+'">点这里打开</a>）';
      } else {
        const icon = s.state==='success' ? '✅ ' : (s.state==='failed'||s.state==='timeout') ? '❌ ' : '';
        $('loginMsg').textContent = icon + s.message + (s.url ? '\\n' + s.url : '');
      }
      if (s.state !== 'waiting') {
        clearInterval(polling); polling = null; setLoginButtons(true); refresh();
      }
    } catch { /* ignore */ }
  }, 1500);
}

async function test() {
  const btn = $('testBtn'); btn.disabled = true; $('testMsg').textContent = '调用中（agent 启动约需几秒）…'; $('testOut').textContent='';
  try {
    const t0 = Date.now();
    const r = await (await fetch('/admin/test', {method:'POST'})).json();
    if (r.ok) $('testOut').textContent = '✅ 成功（'+((Date.now()-t0)/1000).toFixed(1)+'s）模型回复：' + r.reply + '\\n消耗 tokens：' + JSON.stringify(r.usage);
    else $('testOut').textContent = '❌ 失败：' + r.error;
    $('testMsg').textContent = '';
  } catch (e) { $('testOut').textContent = '❌ 请求失败：' + e.message; }
  btn.disabled = false; refresh();
}

refresh();
setInterval(refresh, 8000);
</script>
</body>
</html>`;

function adminPageHtml() {
  return PAGE;
}

module.exports = { adminPageHtml };
