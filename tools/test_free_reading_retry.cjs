// 读书笔记没交 JSON 时补一轮。node tools/test_free_reading_retry.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http'), os = require('node:os'), path = require('node:path');
(async () => {
  const seen = [];
  const or = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      seen.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json');
      if (seen.length === 1) return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '我先去找找看。' } }] }));
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ topic: '星图', why: '好奇', notes: '读到一点星图的历史。', sources: [], note: '', next: '' }) } }] }));
    });
  });
  await new Promise(r => or.listen(0, '127.0.0.1', r));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'islet-retry-'));
  Object.assign(process.env, { ISLET_KEY: 'k'.repeat(30), DATA_DIR: data, ALLOWED_ORIGIN: '*', OPENROUTER_KEY: 'test', OPENROUTER_URL: 'http://127.0.0.1:' + or.address().port + '/chat', FREE_MODEL: 'anthropic/claude-fable-5.1' });
  fs.mkdirSync(path.join(data, 'companions', 'a'), { recursive: true });
  fs.writeFileSync(path.join(data, 'companions', 'a', 'snapshot.json'), JSON.stringify({ name: 'A', cards: [], epis: [], freeTime: true }));
  const { server } = require('../server/server.js');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const r = await fetch('http://127.0.0.1:' + server.address().port + '/own/a/read-now', { method: 'POST', headers: { 'X-Islet-Key': process.env.ISLET_KEY } });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(seen.length, 2);
  assert.equal(seen[1].tool_choice, 'none');
  assert.match(seen[1].messages.at(-1).content, /只返回那个 JSON/);
  assert.equal(seen[1].messages.at(-2).content, '我先去找找看。');
  const list = JSON.parse(fs.readFileSync(path.join(data, 'companions', 'a', 'readings.json'), 'utf8'));
  assert.equal(list[0].topic, '星图');
  console.log('ok'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
