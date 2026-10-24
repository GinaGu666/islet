// Test-only dependencies: jsdom, fake-indexeddb. No real network or model calls.
// NODE_PATH=/tmp/islet-tests/node_modules TZ=Asia/Taipei node tools/test_retired_features.cjs
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom'), { IDBFactory } = require('fake-indexeddb');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const contexts = [], json = x => JSON.parse(JSON.stringify(x));
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } throw Error('Timed out'); }
function app(storage = {}) {
  const errors = [], log = new VirtualConsole();
  log.on('jsdomError', e => { if (!e.message.includes('navigation')) errors.push(e.message); });
  const dom = new JSDOM(html, { url:'https://islet.test/', runScripts:'outside-only', pretendToBeVisual:true, virtualConsole:log });
  contexts.push(dom); const w = dom.window, run = code => vm.runInContext(code, dom.getInternalVMContext());
  w.indexedDB = new IDBFactory(); w.matchMedia = () => ({matches:false, addEventListener(){}});
  w.HTMLElement.prototype.scrollIntoView = () => {}; w.fetch = () => { throw Error('Unexpected network call'); };
  for (const [k,v] of Object.entries(storage)) w.localStorage.setItem(k,v);
  run(source); w.onload = null;
  run(`uiConfirm=async()=>true;uiAlert=async text=>{globalThis.lastAlert=text};downloadFile=(name,content)=>{globalThis.download={name,content}};loadCompanions();loadSessions();showMain();renderAll()`);
  return {w,run,errors};
}
(async () => {
  const ts = Date.now(), unsafe = '<img src=x onerror="window.executed=1">';
  const minutes = {role:'user', content:'旧纪要正文', time:'12:00', ts, council:{topic:'旧议题'+unsafe, minutes:'议题：旧议题\n保留的纪要。', people:['Saturn',unsafe], log:[{n:unsafe,t:'旧原话'+unsafe}]}};
  const drawn = {role:'user', content:'旧抽卡消息', time:'12:01', ts:ts+1, drawn:1};
  const old = [minutes, drawn, {role:'assistant',content:'旧回复',time:'12:01',ts:ts+2}];
  const role = {id:'saturn',name:'Saturn',autoDistill:false,pool:1,cards:[{id:'k',t:'保留记忆',d:ts}]};
  const a = app({islet_companions:JSON.stringify([role,{id:'other',name:'Other',autoDistill:false}]),islet_active_companion:'saturn',islet_cur:'hot',
    islet_idx:JSON.stringify([{id:'cold',companionId:'saturn',first:ts-100,count:1,cold:1},{id:'hot',companionId:'saturn',first:ts,count:old.length}]),
    islet_s_hot:JSON.stringify(old),islet_gacha_pending:'saturn',islet_council_sel:'["saturn","other"]'});
  await a.run(`idbPut('chunks',{id:'cold',msgs:[${JSON.stringify(minutes)}]})`);
  for (const id of ['council-overlay','gacha-overlay']) assert.equal(a.w.document.getElementById(id),null);
  for (const name of ['openCouncil','startCouncil','councilRound','adjournCouncil','openGacha','runGacha','gachaPending','setGachaPending']) assert.equal(a.run('typeof '+name),'undefined');
  assert.equal(a.w.document.querySelector('[onclick*="Council"],[onclick*="Gacha"]'),null);
  assert(a.w.document.getElementById('arena-overlay')); assert.equal(a.run('typeof startArena'),'function');
  assert.equal(a.w.document.querySelectorAll('#chat .council-card').length,1);
  assert(a.w.document.querySelector('#chat .cc-min').textContent.includes('保留的纪要'));
  assert(a.w.document.querySelector('#chat .cc-raw').textContent.includes('旧原话'+unsafe));
  assert.equal(a.w.document.querySelector('#chat .council-card img'),null); assert.equal(a.w.executed,undefined);
  assert.equal(a.w.document.querySelectorAll('#chat .drawn-tag').length,1); assert.deepEqual(json(a.run('messages')),old);
  a.run(`globalThis.counter=chatRoundCounter();counter.add(messages)`); assert.equal(a.run('Array.from(counter.days.values()).reduce((a,b)=>a+b,0)'),1);
  for (const [open,id] of [['openArena','arena-overlay'],['openHabits','habit-overlay'],['openSearch','search-overlay']]) {
    a.run(open+'()'); assert(a.w.document.getElementById(id).classList.contains('show'));
    a.w.document.getElementById(id).dispatchEvent(new a.w.MouseEvent('click',{bubbles:true})); await tick();
    assert(!a.w.document.getElementById(id).classList.contains('show'));
  }
  a.run(`switchCompanion('other');switchCompanion('saturn')`);
  assert.equal(a.w.localStorage.islet_gacha_pending,'saturn'); assert.equal(a.w.localStorage.islet_council_sel,'["saturn","other"]');
  a.run(`streamCompletion=async(model,msgs,signal,onReason,onContent)=>{onContent('普通新回复');return {ended:'done',finish:'stop',usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:80}}}};$('msg-input').value='普通新消息';onSend()`);
  await until(()=>!a.run('isLoading')); const sent=json(a.run('messages'));
  assert.equal(sent.at(-2).content,'普通新消息'); assert.equal(sent.at(-2).drawn,undefined); assert.equal(sent.at(-2).council,undefined);
  assert.deepEqual(sent.slice(0,old.length),old); assert.equal(a.w.localStorage.islet_gacha_pending,'saturn');
  assert.equal(a.w.document.querySelectorAll('#chat .drawn-tag').length,1);
  const api = json(await a.run(`buildApiMessages(messages,currentId)`)); assert(api.some(m=>String(m.content).includes('旧纪要正文')));
  await a.run('exportBackup()'); const backup=JSON.parse(a.w.download.content);
  assert.deepEqual(backup.sessionMsgs.hot.slice(0,old.length),old); assert.deepEqual(backup.sessionMsgs.cold,[minutes]);
  assert.equal(backup.companions.find(c=>c.id==='saturn').pool,1); assert.equal(backup.companions.find(c=>c.id==='saturn').cards[0].t,'保留记忆');
  const b=app(); b.w.fixtureFile=new b.w.File([JSON.stringify(backup)],'old-backup.json',{type:'application/json'});
  b.run(`importBackup({files:[fixtureFile],value:'old-backup.json'})`); await until(()=>String(b.w.lastAlert).includes('导入完成'));
  b.run('loadCompanions();loadSessions();renderAll()');
  await until(()=>!b.run('_loadingOlder'));
  assert.deepEqual(json(await b.run(`loadChunk('cold')`)),[minutes]); assert.deepEqual(json(b.run('messages')).slice(0,old.length),old);
  assert.equal(b.w.document.querySelectorAll('#chat .council-card').length,2); assert.equal(b.w.document.querySelectorAll('#chat .drawn-tag').length,1);
  assert.equal(b.w.document.getElementById('council-overlay'),null); assert.equal(b.w.document.getElementById('gacha-overlay'),null);
  assert.deepEqual(a.errors,[]); assert.deepEqual(b.errors,[]);
  console.log('PASS: council/gacha UI and execution removed; legacy minutes/raw text/markers remain safe, no storage cleanup or stale-pending tagging; ordinary chat, remaining overlays, statistics, cold history and full backup restore preserved.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>contexts.forEach(d=>d.window.close()));
