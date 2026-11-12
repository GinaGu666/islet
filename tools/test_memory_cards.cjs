// Memory-card behaviour (archive instead of delete, …). Mock requests only.
// NODE_PATH=../route-test-runtime/node_modules TZ=Asia/Taipei node tools/test_memory_cards.cjs
// The test body between the BODY markers only uses page globals, so it can also run in a real browser.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom'),{IDBFactory}=require('fake-indexeddb');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');new vm.Script(source);
const errors=[],log=new VirtualConsole();log.on('jsdomError',e=>{if(!e.message.includes('navigation'))errors.push(e.message)});
const dom=new JSDOM(html,{url:'https://islet.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:log});
const w=dom.window,run=code=>vm.runInContext(code,dom.getInternalVMContext());w.indexedDB=new IDBFactory();w.TextDecoder=TextDecoder;
w.matchMedia=()=>({matches:false,addEventListener(){}});w.HTMLElement.prototype.scrollIntoView=()=>{};
w.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'NONE'}}]}),{headers:{'content-type':'application/json'}});
const body=fs.readFileSync(__filename,'utf8').split('/*BODY*/')[2].split('/*END*/')[0];
(async()=>{
  w.localStorage.islet_companions=JSON.stringify([{id:'saturn',name:'Saturn',model:'anthropic/chat',cards:[],epis:[],autoDistill:false}]);
  w.localStorage.islet_active_companion='saturn';run(source);w.onload=null;
  run(`apiKey='test-only-key';selectedModel='anthropic/chat';loadCompanions();sessions=[{id:'tail',companionId:'saturn',first:1,count:0}];currentId='tail';messages=[];saveCurrent();showMain();`);
  const out=await run('(async()=>{'+body+'})()');
  assert.deepEqual(errors,[]);console.log('PASS: '+out);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>w.close());

// 包进一个从不调用的 async 函数里，Node 才能解析这个文件；真正执行的是上面读出来的那段。
async function _body() {
/*BODY*/
const ok = (v, m) => { if (!v) throw new Error('FAIL: ' + m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('FAIL: ' + m + ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); };
const pause = () => new Promise(r => setTimeout(r, 60));
uiConfirm = async () => true; uiAlert = async () => true; let toasts = []; toast = t => toasts.push(t);
let saved = null; downloadFile = (name, content) => { saved = content; };
editingCompanionId = 'saturn';
const c = companions[0], day = 864e5, t0 = Date.now() - 4000 * day;
// MAX_CARDS cards: a thread X(pinned, oldest) ← A(old, never recalled) ← B; the rest are newer filler.
const mk = (id, t, d, extra) => Object.assign({ id, t, d, p: 0, c: '' }, extra || {});
c.cards = [];
for (let i = 0; i < MAX_CARDS - 3; i++) c.cards.push(mk('f' + i, '日常记录第' + i + '条', t0 + (i + 10) * 3600e3, { n: 1 }));
c.cards.push(mk('B', '后来搬进了海边的小屋', t0 + 5 * 3600e3, { prev: 'A', n: 2 }));
c.cards.push(mk('A', '想搬去海边住', t0 + 2 * 3600e3, { prev: 'X' }));
c.cards.push(mk('X', '从小在山里长大', t0, { p: 1 }));
c.cards.sort((a, b) => b.d - a.d);
eq(memCardsOf(c).length, MAX_CARDS, 'filled to the limit');
ok(addMemCard(c, '今天第一次去看了海', true, '事件'), 'new card added');
// 1. Over the limit: moved to the archive, nothing deleted.
eq(memCardsOf(c).length, MAX_CARDS, 'active cards stay at the limit');
eq(memArchOf(c).map(k => k.id), ['A'], 'oldest never-recalled card is archived');
eq(memCardsOf(c).length + memArchOf(c).length, MAX_CARDS + 1, 'no card lost');
ok(memArchOf(c)[0].ar > 0, 'archive time recorded');
ok(toasts.some(t => t.includes('归档')), 'first archive shows a notice');
// 2. Thread not broken: B now follows X.
eq(memCardsOf(c).find(k => k.id === 'B').prev, 'X', 'thread re-linked around archived card');
// 3. Archived cards never reach L0/L2.
ok(!memCoreParts(c).text.includes('想搬去海边住'), 'archived not in L0');
ok(!memRecall(c, [{ role: 'user', content: '想搬去海边住吗' }], new Set()).join('').includes('想搬去海边住'), 'archived not in L2');
// 4. The recall tool and the panel search still find it.
const r = await runTool({ name: 'recall', args: JSON.stringify({ query: '搬去海边' }) }, 'tail', {});
ok(String(r.result).includes('想搬去海边住'), 'recall tool finds archived card');
loadMemoryForm(); memQuery = '想搬去'; renderMemCards();
ok(document.querySelector('#mem-cards').textContent.includes('已归档'), 'panel search lists archived match');
memQuery = ''; setMemFilter('arch');
ok(document.querySelector('#mem-cards .mcard-restore'), 'archive view has restore button');
ok(document.querySelector('#mem-arch-hint').textContent.includes('归档'), 'archive hint line shown');
// 5. Server snapshot carries active cards only.
eq(memSnapshot(c).cards.length, MAX_CARDS, 'snapshot has only active cards');
// 6. Backup round trip keeps the archive; an old backup without the field restores as empty.
await exportBackup(); const backup = JSON.parse(saved);
eq(backup.companions[0].cardsArchived.map(k => k.id), ['A'], 'backup carries the archive');
async function restore(data) { window.qaInput = { value: 'b.json', files: [new File([JSON.stringify(data)], 'b.json')] }; importBackup(qaInput); for (let i = 0; i < 20; i++) await pause(); loadCompanions(); }   // 真实页面会 reload；这里直接重读本机存储
await restore(backup);
eq(memArchOf(companions[0]).map(k => k.id), ['A'], 'archive survives restore');
eq(memCardsOf(companions[0]).length, MAX_CARDS, 'active cards survive restore');
const old = JSON.parse(JSON.stringify(backup)); old.companions.forEach(x => delete x.cardsArchived);
await restore(old);
eq(memArchOf(companions[0]).length, 0, 'old backup → empty archive');
eq(memCardsOf(companions[0]).length, MAX_CARDS, 'old backup cards intact');
// 7. Restoring an archived card does not immediately archive the same card again.
await restore(backup); editingCompanionId = 'saturn';
const c2 = companions[0];
restoreArchivedCard('A');
ok(memCardsOf(c2).some(k => k.id === 'A'), 'restored card is active');
eq(memCardsOf(c2).length, MAX_CARDS, 'still at the limit after restore');
eq(memArchOf(c2).length, 1, 'another card took its place in the archive');
ok(memArchOf(c2)[0].id !== 'A', 'not the restored one');
// 8. Pinned cards are never archived.
const c3 = { id: 'p', name: 'P', cards: [] };
for (let i = 0; i < MAX_CARDS + 2; i++) c3.cards.push(mk('p' + i, '置顶' + i, t0 + i, { p: 1 }));
eq(trimMemCards(c3), 0, 'all-pinned: nothing archived');
eq(c3.cards.length, MAX_CARDS + 2, 'all-pinned: nothing removed');
// ---- 2. English queries reach Chinese cards; whole-word, stemmed matching.
const e = { id: 'e', name: 'E', cards: [] };
[['父亲住院了，她很担心', 'k1'], ['家里的猫叫团子', 'k2'], ['在找新工作', 'k3'], ['喜欢看分类整理的视频', 'k4'], ['周末去海边散步', 'k5'], ['Loves her two dogs', 'k6']]
  .forEach(([t, id], i) => e.cards.push(mk(id, t, t0 + i)));
const hit = q => memRecall(e, [{ role: 'user', content: q }], new Set()).join('\n');
ok(hit('My dad is in the hospital').includes('父亲住院'), 'dad → 父亲');
ok(hit('how is your cat doing').includes('团子'), 'cat → 猫');
ok(!hit('this category of videos').includes('团子'), 'cat does not match category');
ok(hit('still looking for a job').includes('新工作'), 'job → 工作');
ok(hit('walking my dog today').includes('two dogs'), 'dog ↔ dogs');
ok(!memTokens('the and you').size, 'English stop words ignored');
eq(memStem('moving'), memStem('moved'), 'stem moving/moved');
// ---- 3. Promises: fulfilled ones leave the core; reserve for newest normal cards; panel shows occupancy.
const v = { id: 'v', name: 'V', cards: [] };
for (let i = 0; i < 12; i++) v.cards.push(mk('v' + i, '答应过的第' + i + '件事：' + '一起去很远很远的地方看看那片海和山'.repeat(3), t0 + 100 + i, { c: '约定' }));
v.cards.push(mk('new1', '今天新学会了做蛋糕', t0 + 999));
v.cards.sort((a, b) => b.d - a.d);
let core = memCoreParts(v);
ok(core.ids.has('new1'), 'reserve keeps the newest normal card in L0');
ok(core.stats.vowMissed > 0, 'missed promises are counted');
ok(core.stats.pvUsed <= core.stats.pvLimit, 'promises stay within their share');
v.cards.find(k => k.id === 'v11').done = 1;
core = memCoreParts(v);
ok(!core.text.includes('【约定】答应过的第11件事') , 'fulfilled promise no longer tagged as open');
ok(!memVow(v.cards.find(k => k.id === 'v11')), 'memVow false when done');
ok(memSnapshot(v).cards.find(k => k.t.includes('第11件')).done === true, 'snapshot carries done');
companions.push(v); editingCompanionId = 'v'; loadMemoryForm();
ok(document.querySelector('#mem-arch-hint').textContent.includes('常驻'), 'panel shows core occupancy');
ok(document.querySelector('#mem-arch-hint').textContent.includes('约定放不下'), 'panel shows missed promises');
openCardEdit('v3'); ok(document.querySelector('#card-done-row').style.display !== 'none', 'done toggle shown for 约定');
document.querySelector('#card-done').checked = true; saveCardEdit();
ok(v.cards.find(k => k.id === 'v3').done === 1, 'done saved from editor');
openCardEdit('new1'); ok(document.querySelector('#card-done-row').style.display === 'none', 'done toggle hidden for others'); closeCardEdit();
// distill marks a promise done only via explicit FOLLOWUP n DONE
const dv = { id: 'dv', name: 'DV', model: 'anthropic/chat', cards: [mk('p1', '答应一起重读小王子', t0, { c: '约定' }), mk('p2', '答应教她做饭', t0 - 1, { c: '约定' })], epis: [] };
companions.push(dv);
const realChat = chatOnce;
chatOnce = async () => 'SUMMARY: 读完了。\nFOLLOWUP 1 DONE: 一起重读完了小王子 [事件]\nFOLLOWUP 2: 约好下周教做饭 [事件]';
await distillMemory([{ role: 'user', content: '我们读完小王子了' }, { role: 'assistant', content: '嗯' }], dv);
chatOnce = realChat;
ok(dv.cards.find(k => k.id === 'p1').done === 1, 'FOLLOWUP DONE marks promise');
ok(!dv.cards.find(k => k.id === 'p2').done, 'plain FOLLOWUP does not');
// ---- 4. Heat: one recall per natural day.
const h = { id: 'h', name: 'H', cards: [] };
['雨天会想喝热可可', 'a', 'b', 'c', 'd'].forEach((t, i) => h.cards.push(mk('h' + i, t === '雨天会想喝热可可' ? t : '无关记录' + t, t0 + i)));
for (let i = 0; i < 10; i++) memRecall(h, [{ role: 'user', content: '下雨了想喝热可可' }], new Set());
eq(h.cards[0].n, 1, 'ten turns same day → n = 1');
h.cards[0].u -= 2 * day;
memRecall(h, [{ role: 'user', content: '下雨了想喝热可可' }], new Set());
eq(h.cards[0].n, 2, 'another day → n = 2');
// ---- 5. Tidy: batches cover old cards; merge keeps threads.
const tc = { id: 'tc', name: 'TC', model: 'anthropic/chat', cards: [], epis: [] };
for (let i = 0; i < 300; i++) tc.cards.push(mk('t' + i, '记录' + i, t0 + i, { c: i % 2 ? '事件' : '' }));
tc.cards.sort((a, b) => b.d - a.d);
const bs = tidyBatches(tc.cards);
ok(bs.length >= 3, 'many cards → several batches');
ok(bs.every(b => b.length <= TIDY_BATCH), 'batch size capped');
eq(bs.reduce((n, b) => n + b.length, 0), 300, 'every card is in some batch');
companions.push(tc); editingCompanionId = 'tc';
let calls = 0; chatOnce = async (sys, user) => { calls++; return calls === 1 ? 'D: 1 = 过时' : 'NONE'; };
await tidyNow(); chatOnce = realChat;
eq(calls, bs.length, 'one request per batch');
ok(tidyPlan && tidyPlan.items.length === 1, 'proposals gathered in one plan');
closeTidy();
// merge in the middle of a thread: A ← B ← C, merge B with a duplicate D → A ← M ← C
const mc = { id: 'mc', name: 'MC', cards: [mk('C', '后来和好了', t0 + 3, { prev: 'B' }), mk('D', '吵了一架', t0 + 2), mk('B', '和他吵架了', t0 + 1, { prev: 'A' }), mk('A', '认识了他', t0)] };
companions.push(mc);
tidyPlan = { compId: 'mc', items: [{ kind: 'M', ids: ['D', 'B'], olds: [], text: '和他吵了一架', cat: '事件', on: true }] }; applyTidy();
const M = mc.cards.find(k => k.t === '和他吵了一架');
eq(M.prev, 'A', 'merged card takes the old prev');
eq(mc.cards.find(k => k.id === 'C').prev, M.id, 'follow-up re-linked to merged card');
// drop in the middle of a thread keeps it joined
tidyPlan = { compId: 'mc', items: [{ kind: 'D', ids: [M.id], olds: [], on: true }] }; applyTidy();
eq(mc.cards.find(k => k.id === 'C').prev, 'A', 'drop re-links thread');
return 'archive instead of delete, thread kept, not in L0/L2, recall tool + panel search, snapshot, backup + old backup, restore, pinned exempt; EN↔ZH recall, promise done + reserve + panel, heat once a day, tidy batches + thread-safe merge/drop';
/*END*/
}
