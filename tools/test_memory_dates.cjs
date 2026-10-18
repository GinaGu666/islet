// Test-only dependencies: npm install --prefix /tmp/islet-tests jsdom fake-indexeddb
// NODE_PATH=/tmp/islet-tests/node_modules node tools/test_memory_dates.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const contexts = [], plain = value => JSON.parse(JSON.stringify(value));
const pause = () => new Promise(r => setTimeout(r, 30));
const legacy = { id: 'legacy', t: '旧记忆保留原记录时间', d: 1700000000000, p: 1, c: '事实' };
async function app(storage) {
  const errors = [], log = new VirtualConsole();
  log.on('jsdomError', e => { if (!e.message.includes('navigation')) errors.push(e.message); });
  const dom = new JSDOM(html, { url: 'https://islet.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: log });
  contexts.push(dom); const w = dom.window;
  w.indexedDB = new IDBFactory(); w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = () => { throw new Error('No network allowed'); };
  const initial = storage || { islet_companions: JSON.stringify([{ id: 'c1', name: 'QA', cards: [legacy], epis: [], autoDistill: false }]), islet_active_companion: 'c1', islet_cur: 'tail', islet_idx: JSON.stringify([{ id: 'tail', companionId: 'c1', first: Date.now(), updated: Date.now(), count: 0 }]), islet_s_tail: '[]' };
  for (const [k,v] of Object.entries(initial)) w.localStorage.setItem(k,v);
  const run = code => vm.runInContext(code, dom.getInternalVMContext());
  run(source); w.onload = null;
  run(`uiConfirm=async()=>true; uiAlert=async()=>true; toast=t=>{globalThis.lastToast=t}; downloadFile=(name,content)=>{globalThis.download={name,content}}; loadCompanions(); loadSessions(); activeCompanionId='c1'; editingCompanionId='c1'; showMain(); renderAll();`);
  await pause(); return { w, run, errors };
}

(async () => {
  const a = await app(), run = a.run;
  for (const value of ['2024-02-29','2026-05-01','0001-01-01','9999-12-31']) assert.equal(run(`normMemoryDate(${JSON.stringify(value)})`), value);
  for (const value of ['2026-02-29','2026-02-30','2026-13-01','2026-04-31','2026-1-01','0000-01-01','2026-05-01T12:00:00Z',null,7]) assert.equal(run(`normMemoryDate(${JSON.stringify(value)})`), '');
  run(`openCardEdit()`); assert.equal(a.w.document.getElementById('card-date').value, run('dayKey()'));
  run(`$('card-text').value='春天去海边散步'; $('card-date').value='2026-05-01'; setCardCat('事件'); saveCardEdit()`);
  const manual = plain(run('editingCompanion().cards[0]'));
  assert.equal(manual.date, '2026-05-01'); assert(manual.d > legacy.d);
  assert(a.w.document.querySelector('#mem-cards').textContent.includes('2026-05-01'));
  assert(run(`memCoreParts(editingCompanion()).text`).includes('【日期：2026-05-01】'));
  run(`openCardEdit(${JSON.stringify(manual.id)}); $('card-date').value='2024-02-29'; saveCardEdit()`);
  assert.equal(run(`editingCompanion().cards[0].d`), manual.d);
  assert.equal(run(`editingCompanion().cards[0].date`), '2024-02-29');
  run(`openCardEdit('legacy')`); assert.equal(a.w.document.getElementById('card-date').value, '');
  run(`$('card-date').value='2023-10-01'; saveCardEdit()`);
  assert.equal(run(`editingCompanion().cards.find(k=>k.id==='legacy').d`), legacy.d);
  run(`openCardEdit('legacy'); $('card-date').value=''; saveCardEdit()`);
  assert.deepEqual(plain(run(`editingCompanion().cards.find(k=>k.id==='legacy')`)), legacy);
  run(`memQuery='2024-02-29'; renderMemCards()`);
  assert.equal(a.w.document.querySelectorAll('#mem-cards .mcard').length, 1);
  run(`memQuery=''; renderMemCards()`);

  const tool = args => run(`runTool({name:'remember',args:${JSON.stringify(JSON.stringify(args))}},'tail',null)`);
  const remembered = await tool({ text: '夏天读完一本长篇小说', category: '事件', date: '2026-08-12' });
  assert(remembered.result.includes('2026-08-12'));
  assert.equal(run(`editingCompanion().cards[0].date`), '2026-08-12');
  const count = run(`editingCompanion().cards.length`);
  const invalid = await tool({ text: '不能被错误日期保存', date: '2026-02-30' });
  assert(invalid.result.includes('没有保存')); assert.equal(run(`editingCompanion().cards.length`), count);
  await tool({ text: '喜欢安静的阅读环境' }); assert(!('date' in plain(run(`editingCompanion().cards[0]`))));
  const recall = await run(`runTool({name:'recall',args:'{"query":"小说"}'},'tail',null)`);
  assert(recall.result.includes('日期：2026-08-12'));
  run(`addMemCard(editingCompanion(),'无日期的另一条事实'); addMemCard(editingCompanion(),'没有日期的第三条事实')`);
  assert(run(`memRecall(editingCompanion(),[{role:'user',content:'2026-08-12'}],new Set()).join(' ')`).includes('2026-08-12'));
  run(`saveCompanions()`); // Direct helper calls above bypass their normal UI/buildApiMessages persistence.
  run(`exportMemoryMd()`); assert(a.w.download.content.includes('日期 2026-08-12'));
  assert(a.w.download.content.includes('记录于'));

  // Dates survive the real backup reader and normal reload, with old cards unchanged.
  await run('exportBackup()'); const backup = a.w.download.content;
  const snapshot = plain(run('editingCompanion().cards'));
  const b = await app();
  b.w.backupInput = { value: 'backup.json', files: [new b.w.File([backup], 'backup.json', { type: 'application/json' })] };
  b.run('importBackup(backupInput)'); await pause(); await pause();
  b.run('loadCompanions(); loadSessions(); editingCompanionId="c1"');
  assert.deepEqual(plain(b.run('editingCompanion().cards')), snapshot);
  const reloaded = await app(Object.fromEntries(Object.entries(a.w.localStorage)));
  assert.deepEqual(plain(reloaded.run('editingCompanion().cards')), snapshot);

  // Tidying retains a shared explicit date and never merges different known dates.
  run(`globalThis.tidyPool=[{id:'a',t:'甲',d:1,date:'2026-05-01'},{id:'b',t:'乙',d:2,date:'2026-05-02'}]`);
  assert.equal(run(`parseTidy('M: 1,2 => 合并 [事实]',tidyPool).length`), 0);
  run(`tidyPool[1].date='2026-05-01'; editingCompanion().cards=tidyPool; tidyPlan={compId:'c1',items:parseTidy('M: 1,2 => 合并 [事实]',tidyPool)}; applyTidy()`);
  assert.equal(run(`editingCompanion().cards[0].date`), '2026-05-01');
  assert.equal(run(`editingCompanion().cards[0].d`), 1);

  // Character-file import has its own sanitizer; ensure it retains the new optional field too.
  run(`ciData={character:{cards:[{t:'从文件带来的记忆',d:1700000000000,date:'2023-10-12'}]},conversations:[{messages:[{role:'user',content:'fixture',ts:1700000000000}]}]}; $('ci-name').value='导入 QA'; $('ci-target').value='';`);
  await run('runCharacterImport()');
  assert.equal(run(`companions.find(c=>c.name==='导入 QA').cards[0].date`), '2023-10-12');
  assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []); assert.deepEqual(reloaded.errors, []);
  console.log('PASS: manual and model memory dates, validation/leap years, date edit/clear without timestamp changes, display/search/model context/recall, Markdown, reload, backup/import, character import and safe tidy merges.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => contexts.forEach(d=>d.window.close()));
