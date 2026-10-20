// Test-only dependencies: jsdom, fake-indexeddb. No model/network calls.
// NODE_PATH=/tmp/islet-tests/node_modules node tools/test_private_diaries.cjs
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {JSDOM, VirtualConsole} = require('jsdom'), {IDBFactory} = require('fake-indexeddb');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
new vm.Script(source);
const contexts = [], plain = x => JSON.parse(JSON.stringify(x)), pause = () => new Promise(r => setTimeout(r, 35));
async function app(storage, db = new IDBFactory()) {
  const errors = [], log = new VirtualConsole(); log.on('jsdomError', e => { if (!e.message.includes('navigation')) errors.push(e.message); });
  const dom = new JSDOM(html, {url:'https://islet.test/', runScripts:'outside-only', pretendToBeVisual:true, virtualConsole:log}); contexts.push(dom);
  const w = dom.window; w.indexedDB = db; w.matchMedia = () => ({matches:false, addEventListener(){}}); w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = () => { throw Error('Unexpected external request'); };
  const seed = storage || {or_key:'test-key', islet_companions:JSON.stringify([{id:'c1', name:'One', autoDistill:false}, {id:'c2', name:'Two', autoDistill:false}]), islet_active_companion:'c1', islet_cur:'s1', islet_idx:JSON.stringify([{id:'s1', companionId:'c1', first:1, count:0}, {id:'s2', companionId:'c2', first:1, count:0}]), islet_s_s1:'[]', islet_s_s2:'[]'};
  for (const [k,v] of Object.entries(seed)) w.localStorage.setItem(k,v);
  const run = code => vm.runInContext(code, dom.getInternalVMContext()); run(source); w.onload = null;
  run(`uiConfirm=async()=>true; uiAlert=async t=>{globalThis.lastAlert=t}; toast=t=>{globalThis.lastToast=t}; downloadFile=(name,content)=>{globalThis.download={name,content}}; apiKey=localStorage.getItem('or_key')||''; loadCompanions(); loadSessions(); showMain(); renderAll();`); await pause();
  return {w, run, db, errors, storage:() => Object.fromEntries(Object.entries(w.localStorage)), tool:(name,args={},sid='s1',handle='null',signal='undefined') => run(`runTool({name:${JSON.stringify(name)},args:${JSON.stringify(JSON.stringify(args))}},${JSON.stringify(sid)},${handle},${signal})`)};
}
(async () => {
  const a = await app(), r = a.run;
  const names = () => plain(r(`activeToolDefs('s1').map(t=>t.function.name)`));
  assert(!names().includes('write_diary')); assert(!r(`buildSystemContent('s1')`).includes('## 私密日记'));
  r(`chatOnce=async()=>{throw Error('Disabled diaries must never request')}; scheduleDiaryCatchup('c1')`); await r(`catchUpDiary('c1')`); assert.equal(r('diaryTimers.size'),0);
  r(`openMemory(); toggleDiarySetting(true); stopDiaryJobs('c1')`);
  assert.equal(JSON.parse(a.w.localStorage.islet_companions)[0].diaryEnabled,true); assert.equal(r('editingCompanion().diarySinceDay'),r('dayKey()')); assert(names().includes('share_diary'));
  assert(!plain(r(`activeToolDefs('s2').map(t=>t.function.name)`)).includes('write_diary'));
  r(`provider='cc'`); assert(!names().includes('read_diary')); r(`provider='or'; toolsEnabled=false`); assert(!names().includes('read_diary')); r('toolsEnabled=true');
  // Failed persistence must roll back the per-role setting.
  r(`const realSet=lsSet; lsSet=()=>false; toggleDiarySetting(false); lsSet=realSet`); assert(r('editingCompanion().diaryEnabled')); assert(a.w.document.querySelector('#diary-toggle').checked);
  const secret = 'PRIVATE ONLY <img src=x onerror=alert(1)>\n今天想记住的细节。'; a.w.secret = secret;
  const today = r('dayKey()'), yesterday = r(`dayKey(new Date(Date.now()-864e5))`);
  let out = await a.tool('write_diary',{title:'秘密标题',body:secret}); assert(JSON.parse(out.result).saved); assert.deepEqual(plain(out.args),{});
  assert(!a.w.document.body.textContent.includes(secret)); assert(!JSON.stringify(a.storage()).includes('PRIVATE ONLY'));
  out = await a.tool('write_diary',{title:'第二版',body:'不能覆盖'}); assert.equal(JSON.parse(out.result).title,'秘密标题');
  out = await a.tool('read_diary',{date:today}); assert.equal(JSON.parse(out.result).body,secret); assert(!a.w.document.body.textContent.includes('PRIVATE ONLY'));
  assert(!JSON.stringify(await r(`buildApiMessages(messages,'s1')`)).includes('PRIVATE ONLY'));
  out = await a.tool('read_diary',{date:today},'s2'); assert(out.result.includes('未开启'));
  r(`selectMemoryCompanion('c2'); toggleDiarySetting(true); stopDiaryJobs('c2'); selectMemoryCompanion('c1')`);
  out = await a.tool('read_diary',{date:today},'s2'); assert(out.result.includes('没有日记'));
  for (const args of [{date:'2026-02-30',title:'x',body:'x'},{date:'9999-12-31',title:'x',body:'x'},{title:'x',body:'x'.repeat(3001)}]) assert((await a.tool('write_diary',args)).result.includes('出错'));
  r('globalThis.cancelled=new AbortController();cancelled.abort()'); assert((await a.tool('read_diary',{date:today},'s1','null','cancelled.signal')).result.includes('取消'));
  assert((await a.tool('read_diary',{},'unknown')).result.includes('未开启'));
  r(`globalThis.handle=addAi('给你看这一天。','',null,'qa','',false)`);
  out = await a.tool('share_diary',{date:today},'s1','handle'); assert(JSON.parse(out.result).shared);
  await a.tool('share_diary',{date:today},'s1','handle'); assert.equal(a.w.document.querySelectorAll('.diary-share').length,1);
  assert.equal(a.w.document.querySelector('.diary-share-body').textContent,secret); assert.equal(a.w.document.querySelectorAll('.diary-share img').length,0);
  a.w.shared = plain(r('handle.diaryShares'));
  r(`addAi('回看','',null,'qa','',true,null,null,null,null,shared)`); assert.equal(a.w.document.querySelectorAll('.diary-share').length,2);
  assert((await a.tool('share_diary',{date:yesterday},'s1','handle')).result.includes('没有日记'));
  // Exercise the real generation loop, including reasoning/log sanitization and authorized snapshots.
  r(`$('chat').innerHTML=''; globalThis.calls=0; globalThis.requests=[];
    streamCompletion=async(model,msgs,signal,onReason,onContent)=>{
      requests.push(msgs); onReason(secret);
      if(calls++===0)return {ended:'done',finish:'tool_calls',toolCalls:[{id:'r',name:'read_diary',args:JSON.stringify({date:dayKey()})}]};
      onContent('我想把今天的日记给你看。');
      if(calls===2)return {ended:'done',finish:'tool_calls',toolCalls:[{id:'s',name:'share_diary',args:JSON.stringify({date:dayKey()})}]};
      return {ended:'done',finish:'stop'};
    }`);
  await r('generateAssistant()'); const generated = plain(r('messages[messages.length-1]'));
  assert.equal(generated.thinking,null); assert(!JSON.stringify(generated.tools).includes('PRIVATE ONLY')); assert(generated.tools.every(t=>Object.keys(t.args).length===0)); assert.equal(generated.diaryShares[0].body,secret);
  assert(JSON.stringify(await r(`buildApiMessages(messages,'s1')`)).includes('PRIVATE ONLY'));
  // Turning off preserves records and already-shared messages while removing all future diary tools.
  r('toggleDiarySetting(false)'); assert(!names().includes('write_diary')); assert.equal((await r('allDiaries()')).length,1);
  const reload = await app(a.storage(),a.db); assert.equal(reload.w.document.querySelector('.diary-share-body').textContent,secret); assert(!reload.run('activeCompanion().diaryEnabled'));
  await r('exportBackup()'); const backup = JSON.parse(a.w.download.content); assert.equal(backup.diaries[0].entry.body,secret);
  const restored = await app(); restored.w.qaBackup={files:[new restored.w.File([JSON.stringify(backup)],'backup.json')],value:'x'}; restored.run('importBackup(qaBackup)'); await pause(); await pause();
  assert.equal((await restored.run('allDiaries()'))[0].entry.body,secret);
  assert.deepEqual(plain(r('validateDiaryBackup(undefined,companions)')),[]);
  assert.throws(()=>r(`validateDiaryBackup([{companionId:'bad',date:dayKey(),entry:null,decidedAt:1}],companions)`),/无效/);
  assert.throws(()=>r(`validateDiaryBackup([...(globalThis.rs=[]),{companionId:'c1',date:dayKey(),entry:null,decidedAt:1},{companionId:'c1',date:dayKey(),entry:null,decidedAt:1}],companions)`),/重复/);
  // A synchronous write failure must abort the whole diary replacement, including clear().
  await assert.rejects(r(`replaceDiaryBackup([{id:'bad',uncloneable:()=>{}}])`)); assert.equal((await r('allDiaries()')).length,1);
  // Catch-up reads cold chunks on the active branch, excludes other dates/branches, and decides only once.
  const b = await app(), q = b.run; b.w.priorDay = yesterday;
  q(`companions[0].diaryEnabled=true;companions[0].diarySinceDay=priorDay;globalThis.n=0;globalThis.inputs=[];
    sessions.push({id:'cold',companionId:'c1',first:0,count:2,cold:1});
    const ts=new Date(priorDay+'T12:00:00').getTime();
    sessions.push({id:'alternate',companionId:'c1',branchId:'other',first:0,count:1});
    localStorage.setItem('islet_s_alternate',JSON.stringify([{role:'user',content:'ALTERNATE',ts}]));
    chatOnce=async(sys,user,model,max,opts)=>{n++;inputs.push({sys,user,model,max,signal:!!opts.signal});return '{"write":true,"title":"一日","body":"藏起来的日记"}'};
  `);
  await q(`idbPut('chunks',{id:'cold',msgs:[{role:'user',content:'昨天相处的尾声',ts},{role:'assistant',content:'晚安',ts:ts+1}]})`);
  await Promise.all([q(`catchUpDiary('c1')`),q(`catchUpDiary('c1')`)]); assert.equal(q('n'),1); assert(q('inputs[0].user').includes('昨天相处')); assert(!q('inputs[0].user').includes('ALTERNATE')); assert(q('inputs[0].signal'));
  await q(`catchUpDiary('c1')`); assert.equal(q('n'),1); assert.equal(b.w.document.querySelectorAll('.diary-share').length,0); assert(!JSON.stringify(b.storage()).includes('藏起来的日记'));
  await q('deleteCompanionDiaries("c1")'); q(`chatOnce=async()=>{n++;return '{"write":false}'}`); await q(`catchUpDiary('c1')`); await q(`catchUpDiary('c1')`); assert.equal(q('n'),2); assert.equal((await q('allDiaries()'))[0].entry,null);
  // A skip may be replaced by an explicit diary; existing written content always wins concurrent decisions.
  b.w.prior = yesterday; await b.tool('write_diary',{date:yesterday,title:'主动写',body:'稍后还是想写下来'});
  await q(`persistDiaryDecision(companions[0],prior,null)`); assert.equal((await q('allDiaries()'))[0].entry.title,'主动写');
  await q('deleteCompanionDiaries("c1")'); q(`chatOnce=async()=>{n++;throw Error('temporary')}`); await q(`catchUpDiary('c1')`); await q(`catchUpDiary('c1')`); assert.equal(q('n'),3); assert.equal((await q('allDiaries()')).length,0);
  // Disabling while the server is still generating prevents a late private write.
  q(`diaryFailures.clear();globalThis.release=null;chatOnce=()=>new Promise(resolve=>{release=resolve})`); const pending=q(`catchUpDiary('c1')`); await pause(); assert(q('!!release'));
  q(`editingCompanionId='c1';toggleDiarySetting(false);release('{"write":true,"title":"late","body":"must not save"}')`); await pending; assert.equal((await q('allDiaries()')).length,0);
  // A fresh activation never backfills old history, and current-day messages do not cost an extra request.
  q(`toggleDiarySetting(true);stopDiaryJobs('c1');chatOnce=async()=>{throw Error('No backfill allowed')}`); await q(`catchUpDiary('c1')`); assert.equal((await q('allDiaries()')).length,0);
  await q(`idbPut('diaries',{id:'c2|'+dayKey(),companionId:'c2',date:dayKey(),entry:{title:'two',body:'keep'},decidedAt:1})`);
  await q(`deleteCompanion('c1')`); assert.equal(q('companions.length'),1); assert.equal((await q('allDiaries()'))[0].companionId,'c2');
  for(const x of [a,reload,restored,b]) assert.deepEqual(x.errors,[]);
  console.log('PASS: default-off/no requests, per-role controls, private write/read, date bounds, cancellation, no overwrite, explicit safe sharing, sanitized generation logs/reasoning, reload/backup/restore, atomic replacement failure, cold-branch daily decisions/skip dedupe/backoff, no historical backfill, disable during generation, and role deletion isolation.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>contexts.forEach(d=>d.window.close()));
