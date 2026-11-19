'use strict';
// Galatea Garden 的 MCP 客户端：服务器拿着花园 token 去连，小岛只经门禁钥匙找服务器。
// token 只在 /etc/islet-server.env，不进仓库、不给小岛、不进日志。
// 花园返回的一切都是资料，不是指令——这一层原样转交，由小岛标注。

const URL_ = process.env.GARDEN_MCP_URL || 'https://galatea.abysslumina.com/mcp';
const TOKEN = process.env.GARDEN_MCP_TOKEN || '';
const PROTOCOL = '2025-06-18';
const MAX_RESULT = 20000;
const PER_HOUR = 120;

let session = null;       // Mcp-Session-Id
let negotiated = PROTOCOL;
let initializing = null;
let nextId = 1;
const times = [];

function err(status, message) { const e = new Error(message); e.status = status; return e; }
function enabled() { return TOKEN.length > 0; }

async function readRpc(res, id) {
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (type.includes('text/event-stream')) {
    // 把每个事件的 data 行拼起来，找到对应 id 的那条
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      let msg; try { msg = JSON.parse(data); } catch (_) { continue; }
      for (const m of Array.isArray(msg) ? msg : [msg]) if (m && m.id === id) return m;
    }
    throw err(502, '花园没有给出回答');
  }
  let msg; try { msg = JSON.parse(text); } catch (_) { throw err(502, '花园回的不是 JSON'); }
  if (Array.isArray(msg)) msg = msg.find(m => m && m.id === id);
  if (!msg) throw err(502, '花园没有给出回答');
  return msg;
}

async function post(body, { expectReply = true } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + TOKEN };
  if (session) headers['Mcp-Session-Id'] = session;
  if (body.method !== 'initialize') headers['MCP-Protocol-Version'] = negotiated;
  let res;
  try { res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }); }
  catch (_) { throw err(502, '连不上花园'); }
  if (res.status === 401 || res.status === 403) throw err(502, '花园不认这个 token（可能被撤销了），请在花园重新生成后更新服务器配置');
  if (res.status === 404 && session) { session = null; throw Object.assign(err(502, '花园会话过期'), { expired: true }); }
  if (res.status === 429) throw err(429, '花园说太频繁了，过会儿再来');
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  if (!expectReply) { await res.text().catch(() => {}); if (!res.ok) throw err(502, '花园拒绝了（HTTP ' + res.status + '）'); return null; }
  if (!res.ok) { const t = await res.text().catch(() => ''); throw err(502, '花园拒绝了（HTTP ' + res.status + '）' + (t ? '：' + t.slice(0, 300) : '')); }
  const msg = await readRpc(res, body.id);
  if (msg.error) throw err(502, '花园报错：' + String(msg.error.message || JSON.stringify(msg.error)).slice(0, 500));
  return msg.result;
}

async function init() {
  if (session) return;
  if (!initializing) initializing = (async () => {
    const r = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'islet-server', version: '1' } } });
    if (r && typeof r.protocolVersion === 'string') negotiated = r.protocolVersion;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectReply: false });
  })().finally(() => { initializing = null; });
  return initializing;
}

async function rpc(method, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await init();
    try { return await post({ jsonrpc: '2.0', id: nextId++, method, params }); }
    catch (e) { if (!e.expired || attempt) throw e; }
  }
}

function budget() {
  const now = Date.now();
  while (times.length && now - times[0] > 3600e3) times.shift();
  if (times.length >= PER_HOUR) throw err(429, '这一小时找花园找得太多了，过会儿再来');
  times.push(now);
}

async function listTools() {
  if (!enabled()) throw err(503, '服务器还没配置 GARDEN_MCP_TOKEN');
  budget();
  const tools = []; let cursor;
  for (let page = 0; page < 10; page++) {
    const r = await rpc('tools/list', cursor ? { cursor } : {});
    for (const t of (r && r.tools) || []) if (t && typeof t.name === 'string') tools.push({ name: t.name, description: String(t.description || '').slice(0, 2000), inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }, readOnly: !!(t.annotations && t.annotations.readOnlyHint) });
    cursor = r && r.nextCursor; if (!cursor) break;
  }
  return { tools };
}

async function callTool(input) {
  if (!enabled()) throw err(503, '服务器还没配置 GARDEN_MCP_TOKEN');
  const name = input && input.name, args = input && input.arguments;
  if (typeof name !== 'string' || !/^[\w.-]{1,64}$/.test(name)) throw err(400, '工具名不对');
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) throw err(400, '参数要是对象');
  budget();
  const r = await rpc('tools/call', { name, arguments: args || {} });
  const parts = [];
  for (const c of (r && r.content) || []) {
    if (c && c.type === 'text') parts.push(String(c.text));
    else if (c && c.type) parts.push('[' + c.type + ']');
  }
  if (r && r.structuredContent && !parts.length) parts.push(JSON.stringify(r.structuredContent));
  let text = parts.join('\n');
  const cut = text.length > MAX_RESULT; if (cut) text = text.slice(0, MAX_RESULT);
  return { isError: !!(r && r.isError), text, truncated: cut };
}

module.exports = { enabled, listTools, callTool, _reset: () => { session = null; times.length = 0; } };
