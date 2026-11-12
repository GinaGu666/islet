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
return 'archive instead of delete, thread kept, not in L0/L2, recall tool + panel search, snapshot, backup + old backup, restore, pinned exempt';
/*END*/
