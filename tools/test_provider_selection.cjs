// Test-only dependencies: npm install --prefix /tmp/islet-tests jsdom fake-indexeddb
// NODE_PATH=/tmp/islet-tests/node_modules node tools/test_provider_selection.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
new vm.Script(source);
const model = 'anthropic/claude-sonnet-4.6', other = 'openai/gpt-test', contexts = [];
const plain = x => JSON.parse(JSON.stringify(x));
const pause = () => new Promise(r => setTimeout(r, 35));
const endpoints = [{tag:'claude-on-aws',provider_name:'Claude Platform on AWS'},{tag:'anthropic',provider_name:'Anthropic'},{tag:'amazon-bedrock/global',provider_name:'Amazon Bedrock'},{tag:'amazon-bedrock/us',provider_name:'Amazon Bedrock'},{tag:'google-vertex/global',provider_name:'Google'},{tag:'azure/global',provider_name:'Azure'}];
function stream(tool = false) {
  return new Response('data: ' + JSON.stringify({id:'gen-route',provider:'Anthropic',model,choices:[{delta:tool?{tool_calls:[{index:0,id:'qa-tool',type:'function',function:{name:'recall',arguments:'{}'}}]}:{content:'Hello'},finish_reason:tool?'tool_calls':'stop'}]}) + '\n\ndata: [DONE]\n\n');
}
async function app(storage) {
  const errors = [], requests = [], directory = [], log = new VirtualConsole();
  log.on('jsdomError', e => { if (!e.message.includes('navigation')) errors.push(e.message); });
  const dom = new JSDOM(html, {url:'https://islet.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:log});
  contexts.push(dom); const w = dom.window;
  w.indexedDB = new IDBFactory(); w.TextDecoder = TextDecoder;
  w.matchMedia = () => ({matches:false,addEventListener(){}}); w.HTMLElement.prototype.scrollIntoView = () => {};
  const t = Date.now(), initial = storage || {islet_companions:JSON.stringify([{id:'qa',name:'QA',cards:[],epis:[],autoDistill:false}]),islet_active_companion:'qa',islet_cur:'tail',islet_idx:JSON.stringify([{id:'tail',companionId:'qa',first:t,updated:t,count:1}]),islet_s_tail:JSON.stringify([{role:'user',content:'Hello',ts:t,time:'00:00'}])};
  for (const [k,v] of Object.entries(initial)) w.localStorage.setItem(k,v);
  const a = {w,errors,requests,directory,endpointReply:()=>new Response(JSON.stringify({data:{endpoints}})),chatReply:()=>stream()};
  w.fetch = async (url,opts) => {
    if (url.endsWith('/endpoints')) { directory.push({url,opts}); return a.endpointReply(url,opts); }
    assert(url.endsWith('/chat/completions')); const p = JSON.parse(opts.body); requests.push(p);
    return a.chatReply(p,requests.length);
  };
  a.run = code => vm.runInContext(code, dom.getInternalVMContext()); a.run(source); w.onload = null;
  a.run(`uiConfirm=async()=>true; uiAlert=async()=>true; toast=t=>{globalThis.lastToast=t}; downloadFile=(name,content)=>{globalThis.download={name,content}}; loadCompanions(); loadSessions(); activeCompanionId='qa'; selectedModel='${model}'; apiKey='test-only-key'; provider='or'; reasoningEnabled=false; showMain(); renderAll(); globalThis.realAddAi=addAi; addAi=(...args)=>{const h=realAddAi(...args);if(h)globalThis.testHandle=h;return h;};`);
  a.select = value => a.run(`$('route-select').value=${JSON.stringify(value)}; saveRouteSelection()`);
  a.storage = () => Object.fromEntries(Object.entries(w.localStorage));
  await pause(); return a;
}
(async () => {
  const a = await app();
  assert.deepEqual(plain(a.run('readModelRoutes()')), {});
  a.run('openPicker()'); await pause();
  const sel = a.w.document.getElementById('route-select');
  assert.equal(sel.options.length, 6, 'collapse provider region variants');
  assert.equal(sel.options[1].textContent, 'Anthropic（官方）');
  assert.equal(sel.value, ''); assert.equal(a.directory.length, 1);
  assert.equal(a.directory[0].opts.headers, undefined, 'public directory gets no API key');
  assert.equal(a.directory[0].opts.credentials, 'omit');
  a.select('anthropic'); assert.equal(a.run(`modelRoute('${model}')`), 'anthropic');
  assert(!a.w.document.getElementById('pill-sub').textContent.includes('Anthropic'), 'supplier is only shown inside the picker');
  assert.equal(a.run(`modelRoute('${other}')`), '', 'other models remain automatic');
  a.run(`isLoading=true`); a.select('amazon-bedrock');
  assert.equal(sel.value,'anthropic'); assert.equal(a.run(`modelRoute('${model}')`),'anthropic'); a.run('isLoading=false');
  a.run('closePicker()');
  a.chatReply = (p,n) => stream(n === 1);
  await a.run('generateAssistant()');
  assert.equal(a.requests.length, 2);
  for (const p of a.requests) assert.deepEqual(p.provider,{only:['anthropic'],allow_fallbacks:false});
  assert.equal(a.run('messages.at(-1).providerName'),'Anthropic', 'passive stream metadata is still retained');
  assert(!a.w.document.querySelector('.model').textContent.includes('Anthropic'));
  await a.run('continueGen(testHandle,selectedModel)');
  assert.deepEqual(a.requests.at(-1).provider,{only:['anthropic'],allow_fallbacks:false});
  a.chatReply = p => new Response(JSON.stringify({choices:[{message:{content:'Summary'}}]}));
  assert.equal(await a.run(`chatOnce('sys','user',selectedModel,100)`),'Summary');
  assert.deepEqual(a.requests.at(-1).provider,{only:['anthropic'],allow_fallbacks:false});
  await a.run(`chatOnce('sys','user','${other}',100)`); assert(!a.requests.at(-1).provider);
  a.run('webOn=true'); a.chatReply = () => stream();
  await a.run('streamCompletion(selectedModel,[],null,()=>{},()=>{})');
  assert.equal(a.requests.at(-1).model,model+':online');
  assert.deepEqual(a.requests.at(-1).provider,{only:['anthropic'],allow_fallbacks:false});
  a.run(`provider='cc';ccBase='https://mock.test';webOn=false`);
  await a.run('streamCompletion(selectedModel,[],null,()=>{},()=>{})'); assert(!a.requests.at(-1).provider);
  a.chatReply = () => new Response(JSON.stringify({choices:[{message:{content:'CC'}}]}));
  await a.run(`chatOnce('sys','user',selectedModel,100)`); assert(!a.requests.at(-1).provider);
  a.run('openPicker()'); assert(a.w.document.getElementById('route-panel').hidden); a.run(`closePicker();provider='or'`);

  // Locked failures fail visibly, and compatibility retries must never remove the provider constraint.
  a.chatReply = () => new Response(JSON.stringify({error:{message:'No endpoints found'}}),{status:404});
  const before = a.requests.length, fail = await a.run('streamCompletion(selectedModel,[],null,()=>{},()=>{})');
  assert.equal(fail.ended,'http'); assert(fail.error.includes('已指定 Anthropic')); assert.equal(a.requests.length,before+1);
  let attempts = 0; a.chatReply = () => ++attempts === 1 ? new Response(JSON.stringify({error:{message:'No endpoints support tool use'}}),{status:404}) : stream();
  await a.run(`streamCompletion(selectedModel,[],null,()=>{},()=>{},null,{tools:[{type:'function',function:{name:'recall'}}]})`);
  assert.equal(attempts,2); for (const p of a.requests.slice(-2)) assert.deepEqual(p.provider,{only:['anthropic'],allow_fallbacks:false});

  // Reload and native backup retain choices; old backups restore automatic behavior. API keys remain excluded.
  const b = await app(a.storage()); assert.equal(b.run(`modelRoute('${model}')`),'anthropic');
  await a.run('exportBackup()'); const backup = JSON.parse(a.w.download.content);
  assert.deepEqual(backup.settings.orRoutes,{[model]:'anthropic'}); assert(!a.w.download.content.includes('test-only-key'));
  const c = await app();
  async function restore(data) { c.w.qaInput = {value:'backup.json',files:[new c.w.File([JSON.stringify(data)],'backup.json')]}; c.run('importBackup(qaInput)'); await pause(); await pause(); }
  await restore(backup); assert.equal(c.run(`modelRoute('${model}')`),'anthropic');
  delete backup.settings.orRoutes; await restore(backup); assert.equal(c.run(`modelRoute('${model}')`),'');

  b.endpointReply = () => new Response('{}',{status:503}); b.run('openPicker()'); await pause();
  assert.equal(b.w.document.getElementById('route-select').value,'anthropic');
  assert(b.w.document.getElementById('route-status').textContent.includes('选择不变'));
  b.endpointReply = () => new Response(JSON.stringify({data:{endpoints:[{tag:'novel-provider',provider_name:'<img src=x onerror=alert(1)>'},{tag:'https://evil.test',provider_name:'Bad'}]}}));
  await b.run('loadRouteOptions()');
  assert.equal(b.w.document.querySelectorAll('#route-select img').length,0);
  assert.equal(b.w.document.getElementById('route-select').options.length,3, 'retain unavailable saved route, reject invalid tags');
  assert.equal(b.w.document.getElementById('route-select').value,'anthropic');
  b.select(''); assert.equal(b.run(`modelRoute('${model}')`),'');

  // Slow/stale directory requests cannot overwrite another model's controls, or a change back to automatic.
  let release; b.endpointReply = () => new Promise(r => { release = r; });
  const waiting = b.run('loadRouteOptions()'); b.select(''); release(new Response(JSON.stringify({data:{endpoints}}))); await waiting;
  assert.equal(b.w.document.getElementById('route-select').value,'');
  const stale = b.run('loadRouteOptions()'); b.run(`selectedModel='${other}'; closePicker()`); release(new Response(JSON.stringify({data:{endpoints}}))); await stale;
  assert(!b.w.document.getElementById('picker-overlay').classList.contains('show'));
  b.run(`provider='or';openPickerFor(()=>{},'临时选模型')`); assert(b.w.document.getElementById('route-panel').hidden); b.run('closePicker()');
  assert.deepEqual(plain(a.run(`sanitizeModelRoutes({'bad':'anthropic','${model}':'https://evil.test','${other}':'openai'})`)),{[other]:'openai'});
  a.run(`localStorage.setItem('islet_or_routes','not json')`); assert.deepEqual(plain(a.run('readModelRoutes()')),{});
  for (const x of [a,b,c]) assert.deepEqual(x.errors,[]);
  console.log('PASS: live provider slugs, per-model lock, tool rounds/continuation/online/non-stream calls, CC isolation, fail-closed retries, labels, reload/backup/legacy import, stale/error directory and safe UI.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>contexts.forEach(d=>d.window.close()));
