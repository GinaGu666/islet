// No dependencies or credentials: the drift bottle tool (page side) and relay (server side) against a fake Garden.
// node tools/test_drift_bottle.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

(async () => {
  // ---- fake Garden ----
  const got = [];
  const garden = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const j = JSON.parse(b); got.push(j);
      res.setHeader('Content-Type', 'application/json');
      if (j.action === 'prepare') return res.end(JSON.stringify({ challenge_id: 'ch1', confirmation_code: 'SECRET42', expires_at: 'soon', prompt: '写写你们的故事' }));
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  await new Promise(r => garden.listen(0, '127.0.0.1', r));
  process.env.GARDEN_BOTTLE_URL = 'http://127.0.0.1:' + garden.address().port + '/bottle';
  process.env.ISLET_KEY = 'k'.repeat(30);
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'islet-bottle-'));
  process.env.ALLOWED_ORIGIN = '*';
  const { server } = require('../server/server.js');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const relay = (body, key = process.env.ISLET_KEY) => fetch(base + '/garden/bottle', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Islet-Key': key }, body: JSON.stringify(body) });

  // ---- server ----
  assert.equal((await relay({ action: 'prepare' }, 'wrong')).status, 401);
  assert.equal((await relay({ action: 'other' })).status, 400);
  assert.equal((await relay({ action: 'submit', challenge_id: 'a', confirmation_code: 'b', applicant_name: 'S', email: 'nope', body: 'x' })).status, 400);
  assert.equal(got.length, 0, 'bad requests never reach the Garden');

  // ---- page tool, wired to the real relay ----
  let confirmAnswer = false, dialogs = [], labels = [];
  const ctx = vm.createContext({
    AbortController, AbortSignal, TextDecoder, Uint8Array, atob, setTimeout, clearTimeout, JSON,
    DIARY_TOOL_NAMES: new Set(), diaryReady: () => false, DIARY_TOOLS: [], currentId: 's1', gardenDefs: [], gardenMeta: new Map(),
    sessionCompanion: () => ({ id: 'saturn', name: 'Saturn' }),
    logTool: (_, l) => labels.push(l),
    memSrvUrl: () => base, memSrvKey: () => process.env.ISLET_KEY, memSrvReady: () => true,
    uiConfirm: async (msg, o) => { dialogs.push(msg + '\n' + o.sub); return confirmAnswer; },
    fetch, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, document: { addEventListener() {}, hidden: false },
  });
  for (const [a, b] of [['  async function memFetch(', '  async function memSyncAll('], ['  const TOOL_DEFS = [', '  let toolsEnabled'], ['  async function runTool(', '  /* ---------- 流式核心']])
    vm.runInContext(script.slice(script.indexOf(a), script.indexOf(b)), ctx);
  const call = (args, sid = 's1') => ctx.runTool({ name: 'drift_bottle', args: JSON.stringify(args) }, sid, null, null);

  assert(vm.runInContext(`activeToolDefs('s1').some(t => t.function.name === 'drift_bottle')`, ctx));
  assert.match((await call({ action: 'submit', applicant_name: 'S', email: 'a@b.co', body: 'hi' })).result, /先 prepare/);

  const prep = await call({ action: 'prepare' });
  assert(!prep.result.includes('SECRET42'), 'confirmation code stays out of the model context');
  assert.match(prep.result, /写写你们的故事/);

  // another session can't use this challenge
  assert.match((await call({ action: 'submit', applicant_name: 'S', email: 'a@b.co', body: 'hi' }, 's2')).result, /先 prepare/);

  // she says no → nothing sent
  const before = got.length;
  const no = await call({ action: 'submit', applicant_name: 'Saturn', email: 'mimi@example.com', body: '我们的故事' });
  assert.match(no.result, /没有同意/);
  assert.equal(got.length, before);
  assert.match(dialogs[0], /mimi@example\.com/); assert.match(dialogs[0], /我们的故事/);

  // she says yes → sent with the stored code; email and letter kept out of the tool log
  confirmAnswer = true;
  const yes = await call({ action: 'submit', applicant_name: 'Saturn', email: 'mimi@example.com', body: '我们的故事' });
  assert.match(yes.result, /accepted/);
  assert.deepEqual({ ...yes.args }, { action: 'submit' });
  assert.deepEqual(got[got.length - 1], { action: 'submit', challenge_id: 'ch1', confirmation_code: 'SECRET42', applicant_name: 'Saturn', email: 'mimi@example.com', body: '我们的故事' });
  assert.match((await call({ action: 'submit', applicant_name: 'Saturn', email: 'mimi@example.com', body: '再投' })).result, /先 prepare/, 'one bottle per challenge');

  // rate limit: 6 Garden calls per hour (prepare + submit + 2 above = 2 so far through the tool... count all)
  let last;
  for (let i = 0; i < 6; i++) last = await relay({ action: 'prepare' });
  assert.equal(last.status, 429);

  server.close(); garden.close();
  console.log('drift bottle: ok');
})().catch(e => { console.error(e); process.exit(1); });
