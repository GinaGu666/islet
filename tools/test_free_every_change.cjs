// No dependencies or credentials: changing the reading frequency reschedules the next read.
// node tools/test_free_every_change.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.TZ = 'Asia/Taipei';
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'islet-every-'));
Object.assign(process.env, { ISLET_KEY: 'k'.repeat(30), DATA_DIR: data, OPENROUTER_KEY: 'test', OPENROUTER_URL: 'http://127.0.0.1:9/never' });
const { tick, daysAhead, rescheduleFor } = require('../server/server.js');

const DAY = 864e5;
const day = n => { const d = new Date(Date.now() + n * DAY), p = x => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const noon = n => { const d = new Date(Date.now() + n * DAY); d.setHours(12, 0, 0, 0); return d.getTime(); };
function setup(cid, freeEvery, state) {
  const dir = path.join(data, 'companions', cid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ name: cid, cards: [], epis: [], freeTime: true, freeEvery, updatedAt: 1 }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
}
const state = cid => JSON.parse(fs.readFileSync(path.join(data, 'companions', cid, 'state.json'), 'utf8'));

(async () => {
  // 贵公子：以前每周读，读完排到 7 天后；后来改成每天（旧版 state 没记 every）→ 要提前
  setup('weekly2daily', 1, { nextAt: noon(3), lastReadDay: day(-4) });
  // 每天读、今天读过、明天读（旧版 state）→ 不动，只补记 every
  setup('dailyok', 1, { nextAt: noon(1), lastReadDay: day(0) });
  // 每天读、昨天读过、今天失败排到明天重试（旧版 state）→ 不动
  setup('retry', 1, { nextAt: noon(1), lastReadDay: day(-1), lastError: 'x' });
  // 每周读、记过 every=7，改成每天 → 提前
  setup('seven2one', 1, { nextAt: noon(5), lastReadDay: day(-2), every: 7 });
  // 每天读、记过 every=1，今天读过，改成每周 → 排到上次读之后第 7 天
  setup('one2seven', 7, { nextAt: noon(1), lastReadDay: day(0), every: 1 });
  // 每周读、频率没改 → 不动
  setup('weeklyok', 7, { nextAt: noon(6), lastReadDay: day(-1), every: 7 });

  await tick();

  const a = state('weekly2daily');
  assert.equal(a.every, 1);
  assert(a.nextAt >= Date.now() && daysAhead(a.nextAt) <= 1, 'weekly→daily: reads today or tomorrow, not in 3 days');

  assert.equal(state('dailyok').nextAt, noon(1), 'normal daily schedule untouched');
  assert.equal(state('dailyok').every, 1, 'every recorded for old state');
  assert.equal(state('retry').nextAt, noon(1), 'retry schedule untouched');
  assert.equal(state('retry').lastError, 'x');

  const b = state('seven2one');
  assert.equal(b.every, 1);
  assert(b.nextAt >= Date.now() && daysAhead(b.nextAt) <= 1, '7→1: reads today or tomorrow');

  const c = state('one2seven');
  assert.equal(c.every, 7);
  assert.equal(daysAhead(c.nextAt), 7, '1→7: next read 7 days after last read');

  assert.deepEqual(state('weeklyok'), { nextAt: noon(6), lastReadDay: day(-1), every: 7 }, 'unchanged weekly untouched');

  // 已经该读了：落在今天剩下的时段里（10–22 点），或者明天
  const at = new Date(); at.setHours(15, 0, 0, 0);
  for (let i = 0; i < 50; i++) {
    const t = rescheduleFor('2026-01-01', 1, at), h = new Date(t).getHours();
    assert(t > at.getTime() && daysAhead(t, at) === 0 && h >= 15 && h < 22, 'overdue at 15:00 → later today');
  }
  const night = new Date(); night.setHours(23, 0, 0, 0);
  assert.equal(daysAhead(rescheduleFor('2026-01-01', 1, night), night), 1, 'overdue at 23:00 → tomorrow');

  // 再跑一次：不该再改
  const before = JSON.stringify([state('weekly2daily'), state('seven2one'), state('one2seven')]);
  await tick();
  const after = JSON.stringify([state('weekly2daily'), state('seven2one'), state('one2seven')]);
  assert.equal(after, before, 'second tick leaves rescheduled states alone');

  console.log('free every change: ok');
})().catch(e => { console.error(e); process.exit(1); });
