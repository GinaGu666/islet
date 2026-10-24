// Test-only dependencies: jsdom, fake-indexeddb. No network or model requests.
// NODE_PATH=/tmp/islet-tests/node_modules TZ=Asia/Taipei node tools/test_chat_stats.cjs
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom'), { IDBFactory } = require('fake-indexeddb');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const errors = [], log = new VirtualConsole(); log.on('jsdomError', e => errors.push(e.message));
const dom = new JSDOM(html, {url:'https://islet.test/', runScripts:'outside-only', pretendToBeVisual:true, virtualConsole:log});
const w = dom.window, run = code => vm.runInContext(code, dom.getInternalVMContext());
w.indexedDB = new IDBFactory(); w.matchMedia = () => ({matches:false, addEventListener(){}}); w.HTMLElement.prototype.scrollIntoView = () => {};
w.fetch = () => { throw Error('Statistics must not call the network'); };
const storage = () => JSON.stringify(Object.fromEntries(Object.entries(w.localStorage)));
const settle = async () => { for (let i=0;i<30 && w.document.querySelector('#stats-summary').getAttribute('aria-busy')==='true';i++) await new Promise(r=>setTimeout(r,10)); };
(async()=>{
  w.localStorage.islet_companions=JSON.stringify([{id:'c1',name:'Saturn',autoDistill:false},{id:'c2',name:'<img src=x>',autoDistill:false}]);
  w.localStorage.islet_active_companion='c1';w.localStorage.islet_cur='hot';
  run(source);w.onload=null;run(`loadCompanions();globalThis.ts=Date.now();globalThis.today=dayKey();globalThis.yesterday=dayKey(new Date(ts-864e5));
    globalThis.at=(day,hour=12)=>new Date(day+'T'+String(hour).padStart(2,'0')+':00:00').getTime();
    globalThis.cold=[{role:'user',content:'昨天',ts:at(yesterday)},{role:'assistant',content:'回应',ts:at(yesterday)+1},{role:'user',content:'跨块提问',ts:at(today)}];
    globalThis.hot=[{role:'assistant',content:'跨块回答',ts:at(today)+1},{role:'assistant',content:'额外续写',ts:at(today)+2},{role:'user',content:'尚未回复',ts:at(today)+3}];
    sessions=[{id:'cold',companionId:'c1',first:1,count:3,cold:1},{id:'hot',companionId:'c1',first:2,count:3},{id:'alt',companionId:'c1',branchId:'fork',first:1,count:8},{id:'other',companionId:'c2',first:1,count:2}];
    currentId='hot';messages=hot.slice();saveChunk('hot',messages);saveIndex();
    localStorage.setItem('islet_s_alt',JSON.stringify(cold.concat(hot,[{role:'assistant',content:'分支回答',ts:at(today)+4},{role:'assistant',content:'不重复',ts:at(today)+5}])));
    localStorage.setItem('islet_s_other',JSON.stringify([{role:'user',content:'其他角色',ts:at(today)},{role:'assistant',content:'回应',ts:at(today)+1}]));showMain();`);
  await run(`idbPut('chunks',{id:'cold',msgs:cold})`);
  // Normalize provider fields without confusing cache writes, missing cache metrics or zero hits.
  for (const [raw, input, cached] of [
    [{prompt_tokens:1000,prompt_tokens_details:{cached_tokens:800,cache_write_tokens:100}},1000,800],
    [{input_tokens:100,cache_read_input_tokens:800,cache_creation_input_tokens:100},1000,800],
    [{prompt_tokens:1000,cache_read_input_tokens:800},1000,800],
    [{prompt_tokens:100,prompt_tokens_details:{cached_tokens:0}},100,0],
    [{prompt_tokens:100},100,null], [{prompt_tokens:100,prompt_tokens_details:{cached_tokens:200}},100,null],
    [{prompt_tokens:100,prompt_tokens_details:{cache_write_tokens:100}},100,null],
  ]) { w.rawUsage=raw;assert.equal(run('normalizedChatCacheUsage(rawUsage).input'),input);assert.equal(run('normalizedChatCacheUsage(rawUsage).cached'),cached); }
  assert.equal(run('normalizedChatCacheUsage(rawUsage,123).ts'),123);
  run(`hot[0].cacheUsage=[{ts:at(today),input:100,cached:90},{ts:at(today),input:900,cached:10},{ts:at(today),input:200,cached:null}];messages=hot.slice();saveCurrent();
    globalThis.zeroCache=chatCacheCounter();zeroCache.add([{role:'assistant',cacheUsage:[{ts:at(today),input:100,cached:0}]}])`);
  assert.equal(run('chatCacheRate(zeroCache.days.get(today))'),'0.0%');assert.equal(run('chatCacheRate(null)'),'—');
  // Orphan assistants, tool messages, thinking-only replies, council minutes and duplicate continuations.
  run(`globalThis.counter=chatRoundCounter();counter.add([{role:'assistant',content:'孤立回应'},
    {role:'user',content:'问题',ts:at(today)},{role:'tool',content:'工具结果'},{role:'assistant',content:'',thinking:'只有思考'},{role:'assistant',content:'回答'},{role:'assistant',content:'续写'},
    {role:'user',content:'旧问题',ts:at(yesterday)},{role:'user',content:'新问题',ts:at(today)},{role:'assistant',content:'合并回答'},
    {role:'user',content:'纪要',council:{}},{role:'assistant',content:'不算一轮'},
    {role:'user',content:'',imgs:['image'],ts:at(today)},{role:'assistant',content:'看到了'},
    {role:'user',content:'没日期'},{role:'assistant',content:'回答'}]);
    counter.add([{role:'user',content:'午夜前',ts:at(yesterday,23)}]);counter.add([{role:'assistant',content:'午夜后',ts:at(today,0)},{role:'user',content:'未回答',ts:at(today)}]);`);
  assert.equal(run('counter.days.get(today)'),3);assert.equal(run('counter.days.get(yesterday)'),1);assert.equal(run('counter.undated'),1);
  const before=storage();run('openChatStats()');await settle();
  assert.equal(w.document.querySelector('#stats-today').textContent,'1');assert.equal(run('chatStatsData.days.get(yesterday)'),1);
  assert.equal(w.document.querySelector('#stats-cache-today').textContent,'10.0%');assert(w.document.querySelector('#stats-cache-status').textContent.includes('2 / 3'));
  run(`setChatStatsMetric('cache')`);assert.equal(w.document.querySelector('.stats-day.today strong').textContent,'10.0%');run(`setChatStatsMetric('rounds')`);
  assert.equal(w.document.querySelectorAll('#stats-calendar .stats-day').length,new Date(new Date().getFullYear(),new Date().getMonth()+1,0).getDate());
  assert.equal(storage(),before);assert.equal(w.document.querySelector('#stats-companion img'),null);
  run(`$('stats-branch').value='fork'`);await run('loadChatStats()');assert.equal(w.document.querySelector('#stats-today').textContent,'2');
  run(`$('stats-companion').value='c2';changeChatStatsCompanion()`);await settle();assert.equal(w.document.querySelector('#stats-today').textContent,'1');
  assert.equal(w.document.querySelector('#stats-cache-today').textContent,'—');
  run(`$('stats-month').value='2024-02';renderChatStats()`);assert.equal(w.document.querySelectorAll('.stats-day').length,29);
  run(`$('stats-month').value='2025-12';stepChatStatsMonth(1)`);assert.equal(w.document.querySelector('#stats-month').value,'2026-01');
  // A late read for Saturn must not replace a newly selected role's result.
  run(`$('stats-companion').value='c1';changeChatStatsCompanion()`);await settle();
  run(`globalThis.realLoad=loadChunk;globalThis.release=null;loadChunk=id=>id==='cold'?new Promise(resolve=>{release=resolve}):realLoad(id)`);
  const stale=run('loadChatStats()');run(`$('stats-companion').value='c2';changeChatStatsCompanion()`);await settle();run('release(cold)');await stale;
  assert.equal(run('chatStatsData.cid'),'c2');run('loadChunk=realLoad');
  // Refresh reads the current in-memory hot chunk, including a newly completed reply.
  run(`messages.push({role:'assistant',content:'终于回答',ts:at(today)+10});$('stats-companion').value='c1';changeChatStatsCompanion()`);await settle();assert.equal(w.document.querySelector('#stats-today').textContent,'2');
  await run(`idbDel('chunks','cold')`);await run('loadChatStats()');
  assert.equal(w.document.querySelector('#stats-today').textContent,'—');assert(w.document.querySelector('#stats-status').textContent.includes('未能完整读取'));assert.equal(w.document.querySelectorAll('.stats-day').length,0);
  run('closeChatStats()');assert(!w.document.querySelector('#chat-stats-overlay').classList.contains('show'));
  // Real generation: every tool request is counted; continuations and retry replacements retain usage.
  run(`sessions=[{id:'capture',companionId:'c1',first:1,count:1}];currentId='capture';messages=[{role:'user',content:'测试缓存',ts:Date.now()}];saveCurrent();
    globalThis.usageRounds=0;runTool=async()=>({args:{},result:'找到资料',label:'查询'});
    streamCompletion=async(model,msgs,signal,onReason,onContent)=>{
      const first=usageRounds++===0;onContent(first?'先查一下。':'回答。');return {ended:'done',finish:first?'tool_calls':'stop',toolCalls:first?[{id:'cache-test',name:'recall',args:'{}'}]:[],usage:{prompt_tokens:first?100:900,prompt_tokens_details:{cached_tokens:first?90:10}}}
    }`);
  await run('generateAssistant()');assert.equal(run('messages.at(-1).cacheUsage.length'),2);
  run(`globalThis.cacheHandle={row:$('chat').lastElementChild,textEl:$('chat').lastElementChild.querySelector('.ai-text')};
    streamCompletion=async(model,msgs,signal,onReason,onContent)=>{onContent('继续。');return {ended:'done',finish:'stop',usage:{prompt_tokens:100,prompt_tokens_details:{cached_tokens:0}}}}`);
  await run('continueGen(cacheHandle,selectedModel)');assert.equal(run('messages.at(-1).cacheUsage.length'),3);
  run('retryGen(cacheHandle)');for(let i=0;i<30&&run('isLoading');i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(run('messages.at(-1).cacheUsage.length'),4);assert.equal(run('messages.filter(m=>m.role==="assistant").length'),1);
  assert.equal(JSON.parse(w.localStorage.islet_s_capture).at(-1).cacheUsage.length,4);
  assert(!(await run(`buildApiMessages(messages,'capture')`)).some(m=>JSON.stringify(m).includes('cacheUsage')));
  run(`downloadFile=(name,content)=>{globalThis.backupContent=content}`);await run('exportBackup()');assert.equal(run('JSON.parse(backupContent).sessionMsgs.capture.at(-1).cacheUsage.length'),4);
  assert.deepEqual(errors,[]);console.log('PASS: round counts and read-only statistics; provider cache normalization, weighted rates, zero versus unknown, usage capture across tool rounds/continuation/retry, persisted metadata and backup without prompt leakage; cold/hot history, role/branch isolation, months and incomplete-read errors.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>w.close());
