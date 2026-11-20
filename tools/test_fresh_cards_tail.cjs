// node tools/test_fresh_cards_tail.cjs — 聊天中途新记的卡不改 system（缓存前缀），挂在末尾；隔 5 分钟后才并进 system。
// 需要全局安装的 playwright：NODE_PATH=$(npm root -g) node tools/test_fresh_cards_tail.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + path.join(__dirname, '..', 'index.html')); await p.waitForTimeout(800);
  const r = await p.evaluate(async () => {
    const c = sessionCompanion(currentId);
    const cards = memCardsOf(c);
    cards.push({ id: 'old1', t: '她喜欢钩针小熊', d: Date.now() - 86400e3 });
    messages.length = 0;
    messages.push({ role: 'user', content: '你好', time: '10:00', ts: Date.now() }, { role: 'assistant', content: '在呢' }, { role: 'user', content: '记住我爱吃草莓', time: '10:01', ts: Date.now() });
    const sysOf = a => a.find(m => m.role === 'system').content;
    const tailOf = a => a.filter(m => m.role === 'user').pop()._tail || '';
    const a1 = await buildApiMessages(messages, currentId, []);
    cards.push({ id: 'new1', t: '她爱吃草莓', d: Date.now() });            // remember 工具刚记下
    const a2 = await buildApiMessages(messages, currentId, []);
    const fz = coreFreeze.get(currentId); fz.at -= 6 * 60e3;               // 假装隔了 6 分钟
    const a3 = await buildApiMessages(messages, currentId, []);
    return { s1: sysOf(a1), s2: sysOf(a2), s3: sysOf(a3), t2: tailOf(a2), t3: tailOf(a3) };
  });
  assert.equal(r.s2, r.s1, 'system unchanged right after a new card');
  assert(r.s1.includes('钩针小熊'));
  assert(!r.s2.includes('爱吃草莓'));
  assert(r.t2.includes('刚记下的') && r.t2.includes('爱吃草莓'), 'new card shown in the tail');
  assert(r.s3.includes('爱吃草莓'), 'folded into system after idle');
  assert(!r.t3.includes('刚记下的'));
  assert.deepEqual(errs, []);
  await b.close(); console.log('fresh cards tail: ok');
})().catch(e => { console.error(e); process.exit(1); });
