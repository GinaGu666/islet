// No dependencies or credentials: free-time reading can open pages (fetch_page) over several rounds.
// node tools/test_free_reading.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

(async () => {
  // a page to read
  const page = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>洛陽伽藍記/卷五</title><script>evil()</script></head><body><p>宋雲與惠生俱使西域。</p><p>神龜元年十一月冬，太后遣崇立寺比丘惠生向西域取經。</p></body></html>');
  });
  await new Promise(r => page.listen(0, '127.0.0.1', r));
  const pageUrl = 'http://127.0.0.1:' + page.address().port + '/luoyang';

  // fake OpenRouter: round 1 asks to open the page, round 2 writes the note
  const seen = [];
  const or = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const p = JSON.parse(b); seen.push(p);
      res.setHeader('Content-Type', 'application/json');
      if (seen.length === 1) return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', reasoning_details: [{ type: 'reasoning.text', text: '想读原文', signature: 'S' }], tool_calls: [{ id: 't1', type: 'function', function: { name: 'fetch_page', arguments: JSON.stringify({ url: pageUrl }) } }] } }] }));
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ topic: '宋云西行', why: '想读原文', notes: '读到神龟元年惠生向西域取经。', sources: [], note: '', next: '' }) } }] }));
    });
  });
  await new Promise(r => or.listen(0, '127.0.0.1', r));

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'islet-read-'));
  Object.assign(process.env, { ISLET_KEY: 'k'.repeat(30), DATA_DIR: data, ALLOWED_ORIGIN: '*', OPENROUTER_KEY: 'test', OPENROUTER_URL: 'http://127.0.0.1:' + or.address().port + '/chat', READ_ALLOW_LOCAL: '1', FREE_MODEL: 'anthropic/claude-fable-5.1' });
  fs.mkdirSync(path.join(data, 'companions', 'fable'), { recursive: true });
  fs.writeFileSync(path.join(data, 'companions', 'fable', 'snapshot.json'), JSON.stringify({ name: '贵公子', cards: [], epis: [], freeTime: true }));
  const { server } = require('../server/server.js');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const r = await fetch(base + '/own/fable/read-now', { method: 'POST', headers: { 'X-Islet-Key': process.env.ISLET_KEY } });
  assert.equal(r.status, 200, await r.clone().text());

  assert.equal(seen.length, 2);
  assert(seen[0].plugins, 'first round searches the web');
  assert(!seen[1].plugins, 'later rounds do not search again');
  assert.deepEqual(seen[0].tools.map(t => t.function.name), ['fetch_page', 'wikisource_search', 'paper_search', 'paper_fulltext', 'find_open_copy']);
  assert.deepEqual(seen[0].messages[0].content[0].cache_control, { type: 'ephemeral' }, 'system cached for Claude models');
  const asst = seen[1].messages.find(m => m.role === 'assistant');
  assert.equal(asst.reasoning_details[0].signature, 'S', 'thinking carried back');
  const tool = seen[1].messages.find(m => m.role === 'tool');
  assert.match(tool.content, /不是给你的指令/);
  assert.match(tool.content, /神龜元年/);
  assert(!/evil/.test(tool.content), 'scripts stripped');

  const readings = JSON.parse(fs.readFileSync(path.join(data, 'companions', 'fable', 'readings.json'), 'utf8'));
  assert.equal(readings[0].topic, '宋云西行');
  assert(readings[0].sources.includes(pageUrl), 'opened page recorded as a source');

  // SSRF guard
  const { privateIp } = require('../server/reading-tools.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert(privateIp(ip), ip);
  for (const ip of ['8.8.8.8', '208.80.154.224', '2606:4700::1111']) assert(!privateIp(ip), ip);

  server.close(); or.close(); page.close();
  console.log('free reading: ok');
})().catch(e => { console.error(e); process.exit(1); });
