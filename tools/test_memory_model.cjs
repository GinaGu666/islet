// Mock requests only. NODE_PATH=../route-test-runtime/node_modules TZ=Asia/Taipei node tools/test_memory_model.cjs
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom'),{IDBFactory}=require('fake-indexeddb');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const source=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');new vm.Script(source);
const errors=[],log=new VirtualConsole();log.on('jsdomError',e=>{if(!e.message.includes('navigation'))errors.push(e.message)});
const dom=new JSDOM(html,{url:'https://islet.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:log});
const w=dom.window,run=code=>vm.runInContext(code,dom.getInternalVMContext());w.indexedDB=new IDBFactory();w.TextDecoder=TextDecoder;
w.matchMedia=()=>({matches:false,addEventListener(){}});w.HTMLElement.prototype.scrollIntoView=()=>{};
let response='SUMMARY: 今天聊了种花。\nNONE',requests=[];
w.fetch=async(url,opts)=>{requests.push({url,payload:opts&&opts.body?JSON.parse(opts.body):null});if(response instanceof Error)throw response;return new Response(JSON.stringify({choices:[{message:{content:response}}]}),{headers:{'content-type':'application/json'}})};
const pause=()=>new Promise(r=>setTimeout(r,50));
(async()=>{
  w.localStorage.islet_companions=JSON.stringify([{id:'saturn',name:'Saturn',model:'anthropic/chat',cards:[],epis:[],autoDistill:false},{id:'other',name:'Other',model:'openai/other',cards:[],epis:[],autoDistill:false}]);
  w.localStorage.islet_active_companion='saturn';run(source);w.onload=null;
  run(`apiKey='test-only-key';provider='or';selectedModel='anthropic/chat';loadCompanions();sessions=[{id:'tail',companionId:'saturn',first:1,count:4}];currentId='tail';messages=[{role:'user',content:'种花',ts:Date.now(),time:'12:00'},{role:'assistant',content:'好呀',ts:Date.now()},{role:'user',content:'种满天星',ts:Date.now()},{role:'assistant',content:'记下啦',ts:Date.now()}];saveCurrent();showMain();editingCompanionId='saturn';loadMemoryForm();uiConfirm=async()=>true;uiAlert=async()=>true;toast=t=>{globalThis.lastToast=t};downloadFile=(name,content)=>{globalThis.backup=content};catalog=[{id:'anthropic/chat',name:'Chat'},{id:'openai/summary',name:'Summary'}];buildCatalogMap();`);
  assert.equal(run('memoryModel(companions[0])'),'anthropic/chat');assert.equal(run('memoryModel(companions[1])'),'openai/other');
  const initial=run('JSON.stringify(companions)'),n=requests.length;
  run('openSettings();pickMemoryModel();selectModel("openai/summary")');
  assert.equal(requests.length,n,'selection must not spend tokens');assert.equal(run('selectedModel'),'anthropic/chat');assert.equal(run('JSON.stringify(companions)'),initial);
  assert.equal(run('memoryModel(companions[0])'),'openai/summary');assert.equal(run('memoryModel(companions[1])'),'openai/summary');
  assert(w.document.querySelector('#memory-model-label').textContent.includes('openai/summary'));
  run('pickMemoryModel()');assert(w.document.querySelector('.model-row.sel').textContent.includes('Summary'));assert(w.document.querySelector('#route-panel').hidden);run('closePicker();closeSettings()');
  run(`localStorage.setItem('islet_or_routes',JSON.stringify({'openai/summary':'openai'}))`);
  await run('distillNow()');assert.equal(requests.at(-1).payload.model,'openai/summary');assert.deepEqual(requests.at(-1).payload.provider,{only:['openai'],allow_fallbacks:false});
  run(`companions[0].autoDistill=true;sessions[0].distilled=0`);await run(`maybeAutoDistill('tail',messages.slice())`);assert.equal(requests.at(-1).payload.model,'openai/summary');
  run(`companions[0].autoDistill=false;for(let i=0;i<5;i++)addMemCard(companions[0],'Fact '+i);`);response='NONE';await run('tidyNow()');assert.equal(requests.at(-1).payload.model,'openai/summary');
  // Diary and unrelated requests continue to use the original explicitly supplied model.
  response='{"write":false}';await run(`chatOnce('diary','user',companionModel(companions[0]),100,{diary:true})`);assert.equal(requests.at(-1).payload.model,'anthropic/chat');
  assert.equal(run('companionModel(companions[0])'),'anthropic/chat');assert.equal(run('selectedModel'),'anthropic/chat');
  run(`provider='cc';ccBase='https://cc.test';selectedModel='cc-chat';setMemoryModel('cc-summary')`);
  assert.equal(run('memoryModel(companions[0])'),'cc-summary');response='SUMMARY: CC summary\nNONE';await run('distillMemory(messages,companions[0])');assert.equal(requests.at(-1).payload.model,'cc-summary');assert(!requests.at(-1).payload.provider);
  run(`setMemoryModel('');`);assert.equal(run('memoryModel(companions[0])'),'cc-chat');run(`provider='or';selectedModel='anthropic/chat'`);assert.equal(run('memoryModel(companions[0])'),'openai/summary');
  // Failure stays on the chosen summary model, never silently falls back to the chat model.
  response=new Error('Mock upstream failure');const before=requests.length;assert.equal(await run('distillMemory(messages,companions[0])'),null);assert.equal(requests.length,before+1);assert.equal(requests.at(-1).payload.model,'openai/summary');
  response='SUMMARY: 恢复\nNONE';
  // Stale picker callback cannot put an OR ID into the CC slot.
  run(`pickMemoryModel();provider='cc';selectModel('openai/summary')`);assert.equal(run('readMemoryModels().cc'),undefined);run(`provider='or';renderProviderTabs()`);
  // Immediate local persistence, backup/restore and old-backup compatibility; invalid IDs are rejected.
  const saved=w.localStorage.islet_memory_models;assert.equal(JSON.parse(saved).or,'openai/summary');
  run('setMemoryModel("<img src=x>")');assert.equal(w.localStorage.islet_memory_models,saved);assert.equal(w.document.querySelectorAll('#memory-model-label img').length,0);
  await run('exportBackup()');const backup=JSON.parse(w.backup);assert.deepEqual(backup.settings.memoryModels,{or:'openai/summary'});assert(!w.backup.includes('test-only-key'));
  run(`setMemoryModel('')`);assert.equal(run('memoryModel(companions[0])'),'anthropic/chat');
  async function restore(data){w.qaInput={value:'backup.json',files:[new w.File([JSON.stringify(data)],'backup.json')]};run('importBackup(qaInput)');await pause();await pause()}
  await restore(backup);assert.equal(run('readMemoryModels().or'),'openai/summary');
  delete backup.settings.memoryModels;await restore(backup);assert.equal(run('readMemoryModels().or'),undefined);assert.equal(run('memoryModel(companions[0])'),'anthropic/chat');
  run(`localStorage.setItem('islet_memory_models','broken JSON')`);assert.equal(run('memoryModel(companions[0])'),'anthropic/chat');
  assert.deepEqual(errors,[]);console.log('PASS: independent full-catalog picker and highlight, no chat/role mutation or API spend on selection, manual/auto/tidy routing, diary isolation, provider locks, OR/CC isolation, failure without fallback, stale picker, validation and backup/legacy restore.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>w.close());
