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
  assert.equal(a.w.document.querySelector('#diary-status').style.display,'none');
  const names = () => plain(r(`activeToolDefs('s1').map(t=>t.function.name)`));
  assert(!names().includes('write_diary')); assert(!r(`buildSystemContent('s1')`).includes('## 私密日记'));
  r(`chatOnce=async()=>{throw Error('Disabled diaries must never request')}; scheduleDiaryCatchup('c1')`); await r(`catchUpDiary('c1')`); assert.equal(r('diaryTimers.size'),0);
  r(`openMemory(); toggleDiarySetting(true); stopDiaryJobs('c1')`);
  await r('renderDiaryStatus()');assert.equal(a.w.document.querySelector('#diary-status').dataset.phase,'idle');assert(a.w.document.querySelector('#diary-status-hint').textContent.includes('可以关闭'));
  assert.equal(JSON.parse(a.w.localStorage.islet_companions)[0].diaryEnabled,true); assert.equal(r('editingCompanion().diarySinceDay'),r('dayKey()')); assert(names().includes('share_diary'));
  assert(!plain(r(`activeToolDefs('s2').map(t=>t.function.name)`)).includes('write_diary'));
  r(`provider='cc'`); assert(!names().includes('read_diary')); r(`provider='or'; toolsEnabled=false`); assert(!names().includes('read_diary')); r('toolsEnabled=true');
  // Failed persistence must roll back the per-role setting.
  r(`const realSet=lsSet; lsSet=()=>false; toggleDiarySetting(false); lsSet=realSet`); assert(r('editingCompanion().diaryEnabled')); assert(a.w.document.querySelector('#diary-toggle').checked);
  const secret = 'PRIVATE ONLY <img src=x onerror=alert(1)>\n今天想记住的细节。'; a.w.secret = secret;
  const today = r('dayKey()'), yesterday = r(`dayKey(new Date(Date.now()-864e5))`);
  // Scheduling a diary contains no private draft; the independent request starts only after the reply is saved.
  r(`globalThis.chatRounds=0;globalThis.diaryRelease=null;globalThis.diaryInput='';globalThis.diaryStarts=0;
    chatOnce=async(sys,user)=>{diaryStarts++;diaryInput=user;if(isLoading||messages[messages.length-1].content!=='晚安，明天见。')throw Error('Diary started before chat finished');return new Promise(resolve=>{diaryRelease=resolve})};
    streamCompletion=async(model,msgs,signal,onReason,onContent)=>{
      onReason('先好好说晚安，日记留到之后。');
      if(chatRounds++===0)return {ended:'done',finish:'tool_calls',toolCalls:[{id:'q',name:'write_diary',args:JSON.stringify({date:dayKey(),title:'IGNORE',body:'IGNORE THIS LEGACY DRAFT'})}]};
      if(diaryStarts)throw Error('Diary blocked final reply');onContent('晚安，明天见。');return {ended:'done',finish:'stop'};
    }`);
  assert(!r(`JSON.stringify(DIARY_TOOLS[0].function.parameters)`).includes('body'));
  await r('generateAssistant()');await pause();assert.equal(r('isLoading'),false);assert(r('!!diaryRelease'));assert.equal(r('diaryStarts'),1);assert(r('diaryInput').includes('晚安，明天见。'));assert(!r('diaryInput').includes('IGNORE'));
  assert.equal((await r('allDiaries()')).length,0);assert.equal(a.w.document.querySelector('#diary-status').dataset.phase,'deciding');
  assert(r('messages[messages.length-1].thinking').includes('先好好说晚安'));assert(!JSON.stringify(plain(r('messages'))).includes('IGNORE THIS'));
  a.w.diaryOutput=JSON.stringify({write:true,title:'秘密标题',body:secret});r('diaryRelease(diaryOutput)');await r(`diaryWriteQueues.get('c1')`);
  r(`globalThis.writeHandle=addAi('','',null,'qa','',false);writeHandle.row.dataset.sid='s1'`);
  let out = await a.tool('write_diary',{},'s1','writeHandle');assert(JSON.parse(out.result).saved);assert.deepEqual(plain(out.args),{});assert.equal(r('diaryStarts'),1);
  assert.equal(a.w.document.querySelector('#diary-status').dataset.phase,'saved');assert(!a.w.document.querySelector('#diary-status').textContent.includes('秘密标题'));
  assert(!a.w.document.body.textContent.includes(secret)); assert(!JSON.stringify(a.storage()).includes('PRIVATE ONLY'));
  out = await a.tool('write_diary',{title:'第二版',body:'不能覆盖'},'s1','writeHandle');assert(JSON.parse(out.result).saved);assert.equal((await r('allDiaries()'))[0].entry.title,'秘密标题');
  out = await a.tool('read_diary',{date:today}); assert.equal(JSON.parse(out.result).body,secret); assert(!a.w.document.body.textContent.includes('PRIVATE ONLY'));
  assert(!JSON.stringify(await r(`buildApiMessages(messages,'s1')`)).includes('PRIVATE ONLY'));
  out = await a.tool('read_diary',{date:today},'s2'); assert(out.result.includes('未开启'));
  r(`selectMemoryCompanion('c2'); toggleDiarySetting(true); stopDiaryJobs('c2'); selectMemoryCompanion('c1')`);
  out = await a.tool('read_diary',{date:today},'s2'); assert(out.result.includes('没有日记'));
  for (const args of [{date:'2026-02-30'},{date:'9999-12-31'}]) assert((await a.tool('write_diary',args,'s1','writeHandle')).result.includes('出错'));
  assert.throws(()=>r(`diaryEntry('x','x'.repeat(3001))`),/3000/);
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
  // The diary switch must not suppress ordinary reasoning, including the reply after a diary operation.
  r(`streamCompletion=async(model,msgs,signal,onReason,onContent)=>{
    onReason('普通聊天的思考，应该保留。');
    globalThis.reasonHeld=!$('chat').lastElementChild.querySelector('.think-body-inner').textContent.includes('普通聊天的思考');
    onContent('今天也很开心。');return {ended:'done',finish:'stop'};
  }`);
  await r('generateAssistant()'); assert(r('reasonHeld'));
  assert.equal(r('messages[messages.length-1].thinking'),'普通聊天的思考，应该保留。');
  assert.equal(a.w.document.querySelector('#chat').lastElementChild.querySelector('.think-body-inner').textContent,'普通聊天的思考，应该保留。');
  assert(!a.w.document.querySelector('#chat').lastElementChild.querySelector('.think').classList.contains('hidden'));
  // Retain already-public reasoning from an ordinary tool round, but never flash/save the diary round.
  r(`globalThis.round=0;globalThis.privateFlashed=false;streamCompletion=async(model,msgs,signal,onReason,onContent)=>{
    if(round++===0){onReason('先回想一下公开的聊天。');return {ended:'done',finish:'tool_calls',toolCalls:[{id:'c',name:'recall',args:'{"query":"海边"}'}]}}
    onReason(secret);privateFlashed=privateFlashed||$('chat').lastElementChild.textContent.includes(secret);
    if(round===2)return {ended:'done',finish:'tool_calls',toolCalls:[{id:'d',name:'read_diary',args:JSON.stringify({date:dayKey()})}]};
    onContent('有些想法我先留着。');return {ended:'done',finish:'stop'};
  }`);
  await r('generateAssistant()'); assert(!r('privateFlashed')); assert.equal(r('messages[messages.length-1].thinking'),'先回想一下公开的聊天。');
  // An interrupted round is undecided: it might have been about to write a private diary.
  r(`streamCompletion=async(model,msgs,signal,onReason)=>{onReason(secret);return {ended:'aborted'}}`);
  const beforeAbort=r('messages.length');await r('generateAssistant()');assert.equal(r('messages.length'),beforeAbort);
  assert(!a.w.document.querySelector('#chat').lastElementChild.textContent.includes(secret));
  // Turning off preserves records and already-shared messages while removing all future diary tools.
  r('toggleDiarySetting(false)'); assert(!names().includes('write_diary')); assert.equal((await r('allDiaries()')).length,1);
  r(`streamCompletion=async(model,msgs,signal,onReason,onContent)=>{
    onReason('日记关闭时仍实时显示。');globalThis.liveReason=$('chat').lastElementChild.querySelector('.think-body-inner').textContent==='日记关闭时仍实时显示。';
    onContent('普通回复');return {ended:'done',finish:'stop'};
  }`);
  await r('generateAssistant()'); assert(r('liveReason')); assert.equal(r('messages[messages.length-1].thinking'),'日记关闭时仍实时显示。');
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
  assert.equal(b.w.document.querySelector('#diary-status').dataset.phase,'saved');assert(b.w.document.querySelector('#diary-status-text').textContent.includes(yesterday));
  await q(`catchUpDiary('c1')`); assert.equal(q('n'),1); assert.equal(b.w.document.querySelectorAll('.diary-share').length,0); assert(!JSON.stringify(b.storage()).includes('藏起来的日记'));
  await q('deleteCompanionDiaries("c1")'); q(`chatOnce=async()=>{n++;return '{"write":false}'}`); await q(`catchUpDiary('c1')`); await q(`catchUpDiary('c1')`); assert.equal(q('n'),2); assert.equal((await q('allDiaries()'))[0].entry,null);
  assert.equal(b.w.document.querySelector('#diary-status').dataset.phase,'skipped');assert(b.w.document.querySelector('#diary-status-hint').textContent.includes('可以关闭'));
  q(`globalThis.skipHandle=addAi('','',null,'qa','',false);skipHandle.row.dataset.sid='s1'`);
  const decided=await b.tool('write_diary',{date:yesterday},'s1','skipHandle');assert(JSON.parse(decided.result).decided);assert(!q('skipHandle.diaryRequests'));assert.equal(q('n'),2);
  // Atomic storage never overwrites existing written content, even if another job decided to skip.
  b.w.prior = yesterday; await q(`persistDiaryDecision(companions[0],prior,{title:'主动写',body:'稍后还是想写下来'})`);
  await q(`persistDiaryDecision(companions[0],prior,null)`); assert.equal((await q('allDiaries()'))[0].entry.title,'主动写');
  await q('deleteCompanionDiaries("c1")'); q(`chatOnce=async()=>{n++;throw Error('temporary')}`); await q(`catchUpDiary('c1')`); await q(`catchUpDiary('c1')`); assert.equal(q('n'),3); assert.equal((await q('allDiaries()')).length,0);
  await q('renderDiaryStatus()');assert.equal(b.w.document.querySelector('#diary-status').dataset.phase,'failed');
  // Disabling while the server is still generating prevents a late private write.
  q(`diaryFailures.clear();globalThis.release=null;chatOnce=()=>new Promise(resolve=>{release=resolve})`); const pending=q(`catchUpDiary('c1')`); await pause(); assert(q('!!release'));
  assert.equal(b.w.document.querySelector('#diary-status').dataset.phase,'deciding');assert(b.w.document.querySelector('#diary-status-hint').textContent.includes('保留页面'));
  q(`editingCompanionId='c1';toggleDiarySetting(false);release('{"write":true,"title":"late","body":"must not save"}')`); await pending; assert.equal((await q('allDiaries()')).length,0);
  assert.equal(b.w.document.querySelector('#diary-status').style.display,'none');
  // A fresh activation never backfills old history, and current-day messages do not cost an extra request.
  q(`toggleDiarySetting(true);stopDiaryJobs('c1');chatOnce=async()=>{throw Error('No backfill allowed')}`); await q(`catchUpDiary('c1')`); assert.equal((await q('allDiaries()')).length,0);
  await q(`idbPut('diaries',{id:'c2|'+dayKey(),companionId:'c2',date:dayKey(),entry:{title:'two',body:'keep'},decidedAt:1})`);
  await q(`deleteCompanion('c1')`); assert.equal(q('companions.length'),1); assert.equal((await q('allDiaries()'))[0].companionId,'c2');
  // Reload consults durable storage. Failed/slow storage never invents completion or leaks across roles.
  const status=await app(a.storage(),a.db), s=status.run;
  s(`companions[0].diaryEnabled=true;companions[1].diaryEnabled=false`);await s('renderDiaryStatus()');assert.equal(status.w.document.querySelector('#diary-status').dataset.phase,'saved');
  s('setLoading(true)');await s('renderDiaryStatus()');assert(status.w.document.querySelector('#diary-status-hint').textContent.includes('回复还在生成'));s('setLoading(false)');
  s(`globalThis.realGet=idbGet;diaryStatuses.clear();idbGet=async()=>{throw Error('read failure')}`);await s('renderDiaryStatus()');assert.equal(status.w.document.querySelector('#diary-status').dataset.phase,'unknown');
  s(`globalThis.releases=[];idbGet=(store,id)=>store==='diaries'&&id.startsWith('c1|')?new Promise(resolve=>releases.push(resolve)):realGet(store,id)`);
  const slow=s('renderDiaryStatus()');s(`switchCompanion('c2');releases.forEach(resolve=>resolve({entry:{title:'PRIVATE TITLE',body:'PRIVATE BODY'}}))`);await slow;await pause();assert.equal(status.w.document.querySelector('#diary-status').style.display,'none');
  s('idbGet=realGet');
  status.w.statusDay=yesterday;
  s(`switchCompanion('c1');messages.push({role:'user',content:'昨天聊过的事情',ts:new Date(statusDay+'T12:00:00').getTime()});saveCurrent();
    globalThis.realPersist=persistDiaryDecision;globalThis.saveRelease=null;persistDiaryDecision=async(...args)=>{await new Promise(resolve=>{saveRelease=resolve});return realPersist(...args)};
    chatOnce=async()=>'{"write":true,"title":"PRIVATE TITLE","body":"PRIVATE BODY"}'`);
  const saving=s(`catchUpDiary('c1',{date:statusDay,sid:currentId,branchId:activeBranchFor('c1'),model:companionModel(companions[0]),epoch:diaryEpochs.get('c1')||0})`);await pause();assert(s('!!saveRelease'));
  assert.equal(status.w.document.querySelector('#diary-status').dataset.phase,'saving');assert(!status.w.document.querySelector('#diary-status-hint').textContent.includes('可以关闭'));
  s('saveRelease()');await saving;assert.equal(status.w.document.querySelector('#diary-status').dataset.phase,'saved');assert(!status.w.document.querySelector('#diary-status').textContent.includes('PRIVATE'));
  s('persistDiaryDecision=realPersist');
  // Aborted/incomplete chat never launches a new diary request; ordinary chat adds no background request.
  const cancelled=await app(), z=cancelled.run;
  z(`companions[0].diaryEnabled=true;globalThis.n=0;globalThis.round=0;chatOnce=async()=>{n++;throw Error('Must not request')};
    streamCompletion=async(model,msgs,signal,onReason,onContent)=>{
      onReason('正常的聊天思考');if(round++===0)return {ended:'done',finish:'tool_calls',toolCalls:[{id:'q',name:'write_diary',args:'{}'}]};return {ended:'aborted'};
    }`);
  await z('generateAssistant()');await pause();assert.equal(z('n'),0);assert.equal(z('diaryWriteQueues.size'),0);assert.equal((await z('allDiaries()')).length,0);
  z(`streamCompletion=async(model,msgs,signal,onReason,onContent)=>{onReason('普通思考');onContent('普通聊天');return {ended:'done',finish:'stop'}}`);
  await z('generateAssistant()');assert.equal(z('n'),0);assert.equal(z('messages[messages.length-1].thinking'),'普通思考');
  // Turning off then back on invalidates an explicit task waiting behind an older daily job.
  cancelled.w.oldDay=yesterday;
  z(`companions[0].diarySinceDay=oldDay;messages.push({role:'user',content:'昨天的聊天',ts:new Date(oldDay+'T12:00:00').getTime()});saveCurrent();
    globalThis.oldRelease=null;chatOnce=()=>{n++;return new Promise(resolve=>{oldRelease=resolve})}`);
  const older=z(`catchUpDiary('c1')`);await pause();assert(z('!!oldRelease'));
  z(`round=0;streamCompletion=async(model,msgs,signal,onReason,onContent)=>{
    if(round++===0)return {ended:'done',finish:'tool_calls',toolCalls:[{id:'q',name:'write_diary',args:'{}'}]};onContent('晚安');return {ended:'done',finish:'stop'};
  }`);
  await z('generateAssistant()');assert(z('diaryWriteQueues.has("c1")'));
  z(`editingCompanionId='c1';toggleDiarySetting(false);toggleDiarySetting(true);oldRelease('{"write":true,"title":"old","body":"cancelled"}')`);await older;await z(`diaryWriteQueues.get('c1')`);assert.equal(z('n'),1);assert.equal((await z('allDiaries()')).length,0);
  // Reading can be stopped while a background job continues independently; switching roles cannot redirect it.
  const independent=await app(), t=independent.run;
  t(`companions[0].diaryEnabled=true;globalThis.round=0;globalThis.releaseBg=null;globalThis.bgInput='';
    chatOnce=(sys,user)=>{bgInput=user;return new Promise(resolve=>{releaseBg=resolve})};
    streamCompletion=async(model,msgs,signal,onReason,onContent)=>{
      if(round++===0)return {ended:'done',finish:'tool_calls',toolCalls:[{id:'q',name:'write_diary',args:'{}'}]};onContent('先好好睡吧。');return {ended:'done',finish:'stop'};
    }`);
  await t('generateAssistant()');await pause();assert(t('!!releaseBg'));assert(t('bgInput').includes('先好好睡吧。'));
  t('globalThis.readAbort=new AbortController()');const read=independent.tool('read_diary',{date:today},'s1','null','readAbort.signal');t('readAbort.abort()');assert((await read).result.includes('取消'));assert(!t(`diaryControllers.get('c1').signal.aborted`));
  t(`switchCompanion('c2');releaseBg('{"write":true,"title":"独立后台","body":"只有 c1 的日记"}')`);await t(`diaryWriteQueues.get('c1')`);assert.equal((await t('allDiaries()'))[0].companionId,'c1');assert.equal(t('activeCompanionId'),'c2');assert.equal(independent.w.document.querySelector('#diary-status').style.display,'none');
  for(const x of [a,reload,restored,b,status,cancelled,independent]) assert.deepEqual(x.errors,[]);
  console.log('PASS: date-only diary intent, reply-before-background ordering, final response in bounded diary context, ordinary reasoning retained, no draft in chat/logs; aborted chat/no extra ordinary requests, queued epoch cancellation, independent read cancellation and role switch; daily dedupe/skip/privacy, dated status, backup/restore, storage bounds and deletion isolation.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>contexts.forEach(d=>d.window.close()));
