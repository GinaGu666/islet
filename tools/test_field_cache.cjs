// 田：聊天中途新记的卡不改 system（缓存前缀），挂在断点之后；隔 5 分钟才并进 system。
// NODE_PATH=$(npm root -g) node tools/test_field_cache.cjs
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + require('node:path').join(__dirname, '..', 'field', 'index.html')); await p.waitForTimeout(1200);
  const r = await p.evaluate(() => {
    S.cards = [{ id: 'a', text: '岛主钩了小熊' }];
    const list = [{ role: 'user', content: '你好' }];
    const f1 = frozenCards(list), s1 = systemPrompt(f1.kept), t1 = recallTail(list, f1.kept, f1.fresh);
    S.cards = [{ id: 'b', text: '岛主爱吃草莓' }].concat(S.cards);       // 蒸馏刚加了一张
    const f2 = frozenCards(list), s2 = systemPrompt(f2.kept), t2 = recallTail(list, f2.kept, f2.fresh);
    freeze.at -= 6 * 60e3;
    const f3 = frozenCards(list), s3 = systemPrompt(f3.kept), t3 = recallTail(list, f3.kept, f3.fresh);
    return { s1, s2, s3, t2, t3 };
  });
  assert.equal(r.s2, r.s1); assert(!r.s2.includes('草莓')); assert(r.t2.includes('刚记下的') && r.t2.includes('草莓'));
  assert(r.s3.includes('草莓')); assert(!r.t3.includes('刚记下的'));
  assert.deepEqual(errs, []);
  await b.close(); console.log('field cache: ok');
})().catch(e => { console.error(e); process.exit(1); });
