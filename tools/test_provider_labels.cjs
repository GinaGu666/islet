// Test-only dependencies: npm install --prefix /tmp/islet-tests jsdom fake-indexeddb
// NODE_PATH=/tmp/islet-tests/node_modules node tools/test_provider_labels.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const contexts=[], model='anthropic/claude-sonnet-4.6';
const plain=x=>JSON.parse(JSON.stringify(x));
const pause=()=>new Promise(r=>setTimeout(r,30));
function stream({id='gen-test',provider,content='Hello',tool,finish='stop'}={}) {
  const chunks=[{id,model,choices:[{delta:tool?{tool_calls:[{index:0,id:'read-1',type:'function',function:{name:'recall',arguments:'{}'}}]}:{content},finish_reason:tool?'tool_calls':finish}]},{id,model,...(provider===undefined?{}:{provider}),choices:[]}];
  return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n');
}
async function app(responses=[],metadata=()=>({provider_name:'Google Vertex'}),storage) {
  const errors=[],requests=[],lookups=[],log=new VirtualConsole();
  log.on('jsdomError',e=>{if(!e.message.includes('navigation'))errors.push(e.message)});
  const dom=new JSDOM(html,{url:'https://islet.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:log});contexts.push(dom);
  const w=dom.window;w.indexedDB=new IDBFactory();w.TextDecoder=TextDecoder;
  w.matchMedia=()=>({matches:false,addEventListener(){}});w.HTMLElement.prototype.scrollIntoView=()=>{};
  const t=Date.now(),seed=storage||{islet_companions:JSON.stringify([{id:'qa',name:'QA',cards:[],epis:[],autoDistill:false}]),islet_active_companion:'qa',islet_cur:'tail',islet_idx:JSON.stringify([{id:'tail',companionId:'qa',first:t,updated:t,count:1}]),islet_s_tail:JSON.stringify([{role:'user',content:'Hello',ts:t,time:'00:00'}])};
  for(const[k,v]of Object.entries(seed))w.localStorage.setItem(k,v);
  w.fetch=async(url,opts)=>{
    if(url.includes('/generation?')){lookups.push({url,opts});const d=await metadata(lookups.length,opts);return d instanceof Response?d:new Response(JSON.stringify({data:d}));}
    assert(url.includes('/chat/completions'));requests.push(JSON.parse(opts.body));assert(responses.length,'unexpected model request');return stream(responses.shift());
  };
  const run=code=>vm.runInContext(code,dom.getInternalVMContext());run(script);w.onload=null;
  run(`uiConfirm=async()=>true; uiAlert=async()=>true; toast=()=>{}; downloadFile=(name,content)=>{globalThis.download={name,content}}; loadCompanions(); loadSessions(); activeCompanionId='qa'; selectedModel='${model}'; apiKey='test-only-key'; provider='or'; reasoningEnabled=false; showMain(); renderAll(); globalThis.realAddAi=addAi; addAi=(...args)=>{const h=realAddAi(...args);if(h)globalThis.testHandle=h;return h;};`);
  await pause();return{w,run,requests,lookups,errors,storage:()=>Object.fromEntries(Object.entries(w.localStorage))};
}
(async()=>{
  // A provider delivered in a later SSE frame is retained without an extra request.
  const direct=await app([{provider:'Anthropic'}]);await direct.run('generateAssistant()');
  assert.equal(direct.lookups.length,0);assert.equal(direct.run('messages.at(-1).providerName'),'Anthropic');
  assert.equal(direct.run('messages.at(-1).generationId'),'gen-test');
  assert(direct.w.document.querySelector('.model').textContent.endsWith(' · Anthropic'));
  const reload=await app([],undefined,direct.storage());
  assert(reload.w.document.querySelector('.model').textContent.endsWith(' · Anthropic'));
  await direct.run('exportBackup()');assert.equal(JSON.parse(direct.w.download.content).sessionMsgs.tail.at(-1).providerName,'Anthropic');

  // Each tool request is independent: use the final response's provider, never the earlier tool round.
  const fallback=await app([{id:'gen-tool',provider:'Anthropic',tool:true},{id:'gen-final'}]);await fallback.run('generateAssistant()');
  assert.equal(fallback.lookups.length,1);assert(fallback.lookups[0].url.endsWith('id=gen-final'));
  assert.deepEqual(plain(fallback.lookups[0].opts.headers),{Authorization:'Bearer test-only-key'});
  assert.equal(fallback.run('messages.at(-1).providerName'),'Google Vertex');
  assert(!JSON.stringify(fallback.run('messages.at(-1)')).includes('test-only-key'));
  assert.equal(fallback.requests.length,2,'metadata lookup never invokes the model');

  const missing=await app([{}],()=>new Response('{}',{status:403}));await missing.run('generateAssistant()');
  assert.equal(missing.run('messages.at(-1).content'),'Hello');assert.equal(missing.run('messages.at(-1).providerName'),'');
  assert(missing.w.document.querySelector('.model').textContent.includes('供应商未知'));
  assert.equal(missing.run('isLoading'),false);
  const delayed=await app([{}],n=>n===1?new Response('{}',{status:404}):({provider_name:'Amazon Bedrock'}));await delayed.run('generateAssistant()');
  assert.equal(delayed.lookups.length,2);assert.equal(delayed.run('messages.at(-1).providerName'),'Amazon Bedrock');

  const invalid=await app([{id:'not-a-generation',provider:{order:['Anthropic']}}]);await invalid.run('generateAssistant()');
  assert.equal(invalid.lookups.length,0);assert.equal(invalid.run('messages.at(-1).providerName'),'');
  const escaped=await app([{provider:'<img src=x onerror=alert(1)>'}]);await escaped.run('generateAssistant()');escaped.run('renderAll()');
  assert.equal(escaped.w.document.querySelectorAll('.model img').length,0);
  assert(escaped.w.document.querySelector('.model').textContent.includes('<img'));

  const continuation=await app([{id:'gen-first',provider:'Anthropic',content:'Part one ',finish:'length'},{id:'gen-cont',provider:'Google Vertex',content:'part two'}]);
  await continuation.run('generateAssistant()');await continuation.run(`continueGen(testHandle,selectedModel)`);
  assert(continuation.run('messages.at(-1).content').includes('part two'));
  assert.equal(continuation.run('messages.at(-1).providerName'),'Google Vertex');
  assert.equal(continuation.run('messages.at(-1).generationId'),'gen-cont');
  assert(continuation.w.document.querySelector('.model').textContent.includes('Google Vertex'));

  // No supplier inference for custom endpoints or old history without recorded provider metadata.
  const custom=await app([{provider:'Anthropic'}]);custom.run(`provider='cc'; ccBase='https://mock.test';`);
  custom.run(`streamCompletion=async(model,msgs,signal,onReason,onContent)=>{onContent('Custom reply');return{ended:'done',finish:'stop',toolCalls:[]}}`);
  await custom.run('generateAssistant()');assert(!('providerName'in plain(custom.run('messages.at(-1)'))));
  assert(!custom.w.document.querySelector('.model').textContent.includes(' · '));

  // Timeout and cancellation return an empty metadata result and keep the normal reply usable.
  direct.w.fetch=(_,opts)=>new Promise((resolve,reject)=>{const abort=()=>reject(new Error('aborted'));if(opts.signal.aborted)abort();else opts.signal.addEventListener('abort',abort,{once:true});});
  const controller=new direct.w.AbortController();direct.w.qaSignal=controller.signal;
  const pending=direct.run(`lookupGenerationProvider('gen-cancel','test-only-key',qaSignal)`);controller.abort();assert.equal(await pending,'');
  const originalTimer=direct.w.setTimeout;direct.w.setTimeout=(fn,ms)=>originalTimer(fn,ms===2000?1:ms);
  assert.equal(await direct.run(`lookupGenerationProvider('gen-timeout','test-only-key')`),'');
  for(const a of [direct,reload,fallback,missing,delayed,invalid,escaped,continuation,custom])assert.deepEqual(a.errors,[]);
  console.log('PASS: streamed/fallback providers, final tool-round attribution, metadata-only requests, unknown/error/404/timeout/cancel behavior, safe labels, history/backup, continuation and custom endpoint compatibility.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>contexts.forEach(d=>d.window.close()));
