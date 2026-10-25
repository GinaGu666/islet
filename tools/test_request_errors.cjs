// Test-only dependencies: jsdom, fake-indexeddb. Mock responses only; no model/network calls.
// NODE_PATH=../route-test-runtime/node_modules TZ=Asia/Taipei node tools/test_request_errors.cjs
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {JSDOM, VirtualConsole} = require('jsdom'), {IDBFactory} = require('fake-indexeddb');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
new vm.Script(source);
const errors = [], log = new VirtualConsole(); log.on('jsdomError', e => errors.push(e.message));
const dom = new JSDOM(html, {url:'https://islet.test/', runScripts:'outside-only', pretendToBeVisual:true, virtualConsole:log});
const w = dom.window, run = code => vm.runInContext(code, dom.getInternalVMContext());
w.indexedDB = new IDBFactory(); w.TextDecoder = TextDecoder;
w.matchMedia = () => ({matches:false, addEventListener(){}}); w.HTMLElement.prototype.scrollIntoView = () => {};
let reply, calls = [], copied = '';
w.fetch = async (url, opts) => { calls.push({url,opts}); return reply(url,opts); };
Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>{copied=text}},configurable:true});
const json = (data,status=200,headers={}) => new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const sse = (...parts) => new Response(parts.map(x => 'data: '+JSON.stringify(x)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
const fail = (message, code=429) => ({error:{code,message,metadata:{provider_name:'Anthropic',raw:JSON.stringify({error:{type:'rate_limit_error',code:'upstream_rate',message:'Rate limit reached at provider'}}),flagged_input:'PRIVATE CHAT',headers:{Authorization:'SECRET HEADER'}}}});
const stream = () => run('streamCompletion(selectedModel,[],null,()=>{},()=>{})');
(async()=>{
  w.localStorage.setItem('islet_companions',JSON.stringify([{id:'qa',name:'Saturn',cards:[],epis:[],autoDistill:false}]));
  w.localStorage.setItem('islet_active_companion','qa');w.localStorage.setItem('islet_cur','tail');
  run(source);w.onload=null;
  run(`loadCompanions();selectedModel='anthropic/claude-sonnet-4.6';apiKey='TEST-OR-SECRET';ccKey='TEST-CC-SECRET';localStorage.setItem('islet_notion_key','TEST-NOTION-SECRET');
    sessions=[{id:'tail',companionId:'qa',count:1,first:1}];currentId='tail';messages=[{role:'user',content:'Hello',time:'10:00',ts:Date.now()}];saveCurrent();showMain();renderAll();
    delay=async()=>{};toast=t=>{globalThis.lastToast=t};globalThis.realAddAi=addAi;addAi=(...args)=>{const h=realAddAi(...args);if(h)globalThis.handle=h;return h};
    localStorage.setItem('islet_or_routes',JSON.stringify({[selectedModel]:'anthropic'}));`);
  reply=()=>json(fail('Too many requests'),429,{'x-request-id':'req-429','retry-after':'35'});
  let r=await stream();assert.equal(r.ended,'http');assert.equal(r.failure.status,429);assert.equal(r.failure.code,'429');
  assert.equal(r.failure.requestId,'req-429');assert.equal(r.failure.retryAfter,'35');assert.equal(r.failure.provider,'Anthropic');
  assert.equal(r.failure.upstreamMessage,'Rate limit reached at provider');assert(r.error.includes('已指定 Anthropic'));assert(!r.error.includes('PRIVATE CHAT'));assert(!r.error.includes('SECRET HEADER'));
  for(const status of [400,401,402,403,404,408,413,422,429,500,502,503,504,529]){
    reply=()=>json({error:{message:'Diagnostic '+status,type:'upstream_error',code:'typed_'+status}},status);
    r=await stream();assert.equal(r.failure.status,status);assert(r.error.includes('Diagnostic '+status));assert(r.error.includes('typed_'+status));
  }
  // Preserve nested provider diagnostics, FastAPI validation and plain-text/HTML HTTP failures.
  reply=()=>json({detail:[{loc:['body','model'],msg:'Field required',input:{messages:'DO NOT EXPOSE INPUT'}}]},422);
  r=await stream();assert(r.error.includes('Field required'));assert(!r.error.includes('DO NOT EXPOSE INPUT'));
  reply=()=>new Response('<html><script>alert(1)</script><h1>Bad gateway</h1><p>upstream timeout</p></html>',{status:502});
  r=await stream();assert.equal(r.failure.status,502);assert(r.error.includes('Bad gateway'));assert(!r.error.includes('alert(1)'));
  reply=()=>new Response(null,{status:503});r=await stream();assert(r.error.includes('上游未返回'));
  const oversized='A'.repeat(60000);reply=()=>new Response(oversized,{status:502});r=await stream();assert(r.failure.message.length<1850);
  // Redact active keys, bearer credentials, secret assignments and URL credentials/query/fragment.
  reply=()=>json({error:{message:'TEST-OR-SECRET TEST-CC-SECRET TEST-NOTION-SECRET Bearer bearer_other sk-other-key password=pass123 api_key="apikey123" https://user:pass@host.test/v1?token=url_secret#hidden <img src=x onerror=alert(1)>'}},401);
  r=await stream();for(const secret of ['TEST-OR-SECRET','TEST-CC-SECRET','TEST-NOTION-SECRET','bearer_other','sk-other-key','pass123','apikey123','url_secret','user:pass'])assert(!r.error.includes(secret),secret);
  // Error events with HTTP 200, with or without a final newline, must not become successful replies.
  for(const withNewline of [true,false]){
    reply=()=>new Response('data: '+JSON.stringify(fail('SSE failed',502))+(withNewline?'\n\n':''),{headers:{'content-type':'text/event-stream','request-id':'stream-request'}});
    r=await stream();assert.equal(r.ended,'http');assert.equal(r.failure.status,200);assert.equal(r.failure.code,'502');assert(r.error.includes('SSE failed'));
  }
  reply=()=>json({error:{message:'JSON error on a streaming request',code:403}});r=await stream();assert.equal(r.ended,'http');assert(r.error.includes('JSON error'));
  reply=()=>new Response(JSON.stringify({error:{message:'JSON without content type',code:502}}));r=await stream();assert.equal(r.ended,'http');assert(r.error.includes('without content type'));
  reply=()=>new Response('<html>Wrong URL</html>');r=await stream();assert.equal(r.failure.kind,'format');
  reply=()=>sse({choices:[{delta:{},finish_reason:'error'}]});r=await stream();assert.equal(r.ended,'http');
  reply=()=>sse({choices:[{delta:{content:'Partial'},finish_reason:null}]});r=await stream();assert.equal(r.ended,'network');assert(r.error.includes('没有收到完成标记'));
  // Network diagnostics must not guess that CORS, credentials, or a particular server caused the failure.
  reply=()=>{throw new TypeError('Failed to fetch TEST-OR-SECRET')};r=await stream();assert.equal(r.failure.status,null);assert.equal(r.failure.kind,'network');assert(r.error.includes('无法仅凭此确定'));assert(!r.error.includes('TEST-OR-SECRET'));
  reply=()=>{const e=new Error('Canceled');e.name='AbortError';throw e};r=await stream();assert.equal(r.ended,'aborted');assert(!r.failure);
  // Existing compatibility retry still works and cannot silently remove a provider lock.
  let count=0;reply=()=>++count===1?json({error:{message:'No endpoints support tool use'}},404):sse({choices:[{delta:{content:'OK'},finish_reason:'stop'}]});
  r=await run(`streamCompletion(selectedModel,[],null,()=>{},()=>{},null,{tools:[{type:'function',function:{name:'recall'}}]})`);
  assert.equal(r.ended,'done');assert.equal(count,2);for(const c of calls.slice(-2))assert.deepEqual(JSON.parse(c.opts.body).provider,{only:['anthropic'],allow_fallbacks:false});
  // Non-streaming requests expose the same selected fields, including errors delivered with HTTP 200.
  reply=()=>json(fail('Background request failed'),429,{'request-id':'once-id'});
  await assert.rejects(run(`chatOnce('private system','private input',selectedModel,200)`),e=>e.requestFailure.requestId==='once-id'&&e.message.includes('Background request failed')&&!e.message.includes('private system'));
  reply=()=>json({error:{message:'Non-stream error with 200',type:'permission_error'}});
  await assert.rejects(run(`chatOnce('sys','user',selectedModel,200)`),/Non-stream error with 200/);
  reply=()=>new Response('<html>wrong endpoint</html>');await assert.rejects(run(`chatOnce('sys','user',selectedModel,200)`),/格式异常/);
  reply=()=>json({choices:[{message:{content:'Success'}}]});assert.equal(await run(`chatOnce('sys','user',selectedModel,200)`),'Success');
  // CC endpoint diagnostics retain useful address information without credentials or query strings.
  run(`provider='cc';ccBase='https://user:pass@cc.test/bridge?api_key=query-secret#frag'`);
  reply=()=>json({error:{message:'CC unauthorized TEST-CC-SECRET'}},401);
  r=await stream();assert.equal(r.failure.channel,'CC 自建接口');assert(r.failure.endpoint.startsWith('https://cc.test/bridge'));assert(!r.failure.endpoint.includes('query-secret'));assert(!r.error.includes('TEST-CC-SECRET'));assert.equal(r.failure.route,'');
  run(`provider='or';ccBase='';`);
  reply=()=>json({error:{message:'Model catalog denied TEST-OR-SECRET',code:401}},401);
  await run('fetchModels()');assert(run('catalogErr').includes('Model catalog denied'));assert(!run('catalogErr').includes('TEST-OR-SECRET'));run(`renderModelList('')`);assert.equal(w.document.querySelectorAll('#model-list img').length,0);
  // Full UI: visible summary + collapsible/copyable details. Errors never enter messages or backups.
  reply=()=>json(fail('TEST-OR-SECRET UI rate limit'),429,{'x-request-id':'ui-request'});
  await run('generateAssistant()');
  let box=w.document.querySelector('.request-error');assert(box);assert(box.querySelector('.request-error-title').textContent.includes('HTTP 429'));
  assert.equal(box.querySelector('details').open,false);assert(box.querySelector('pre').textContent.includes('ui-request'));
  assert(!box.querySelector('pre').textContent.includes('TEST-OR-SECRET'));assert.equal(run('messages.length'),1);assert.equal(run('isLoading'),false);
  box.querySelector('button').click();await new Promise(r=>setTimeout(r,0));assert(copied.includes('ui-request'));assert(!copied.includes('TEST-OR-SECRET'));
  assert(!JSON.stringify(Object.fromEntries(Object.entries(w.localStorage))).includes('ui-request'));
  const api=await run(`buildApiMessages(messages,currentId)`);assert(!JSON.stringify(api).includes('ui-request'));
  // Mid-stream failure preserves partial content and offers continuation; successful finalization cannot erase details.
  reply=()=>sse({choices:[{delta:{content:'Already received.'}}]},fail('Mid-stream failed',502));
  await run('generateAssistant()');box=w.document.querySelectorAll('.request-error')[1];assert(box);
  assert.equal(run('messages.at(-1).content'),'Already received.');assert.equal(run('messages.at(-1).thinking'),null);
  assert(box.parentElement.querySelector('.ai-text').textContent.includes('Already received.'));assert(box.textContent.includes('Mid-stream failed'));
  assert([...box.querySelectorAll('button')].some(b=>b.textContent==='继续生成'));
  assert(!JSON.stringify(await run(`buildApiMessages(messages,currentId)`)).includes('Mid-stream failed'));
  // Continuation failures have the same details, while successful retry removes the old diagnostic panel.
  reply=()=>json({error:{message:'Continuation denied',code:403}},403);await run('continueGen(handle,selectedModel)');
  assert(w.document.querySelectorAll('.request-error')[1].querySelector('pre').textContent.includes('Continuation denied'));
  assert(w.document.body.textContent.includes('Continuation denied'));assert.equal(run('messages.at(-1).content'),'Already received.');
  reply=()=>sse({choices:[{delta:{content:' Continued.'},finish_reason:'stop'}]});await run('continueGen(handle,selectedModel)');
  assert(!w.document.body.textContent.includes('Continuation denied'));assert.equal(run('messages.at(-1).content'),'Already received. Continued.');
  // Details are always text nodes; upstream markup cannot execute or add elements.
  w.fixture=run(`requestFailure(requestContext(selectedModel),null,{message:'<img src=x onerror=alert(1)>'})`);
  run(`showRequestFailure(handle,fixture,selectedModel,true)`);assert.equal(w.document.querySelectorAll('.request-error img').length,0);
  // Old error actions must never delete a newer reply or launch concurrent requests.
  const oldRetry=w.document.querySelector('.request-error button:last-child');
  run(`isLoading=true`);const beforeBusy=calls.length;oldRetry.click();assert.equal(calls.length,beforeBusy);assert(w.lastToast.includes('当前回复'));run(`isLoading=false`);
  run(`messages.push({role:'user',content:'A newer message',ts:Date.now()})`);const beforeOld=JSON.stringify(run('messages'));oldRetry.click();assert.equal(JSON.stringify(run('messages')),beforeOld);assert(w.lastToast.includes('之后已有新消息'));
  // Real backend errors while reading an error body must still honor explicit cancellation.
  reply=()=>({ok:false,status:502,body:{getReader:()=>({read:async()=>{const e=new Error('aborted body');e.name='AbortError';throw e}})}});
  r=await stream();assert.equal(r.ended,'aborted');
  assert.deepEqual(errors,[]);
  console.log('PASS: detailed HTTP/typed/provider/plain-text/HTML errors; bounded and redacted diagnostics; HTTP-200/SSE/no-newline errors; premature EOF/network/abort; non-stream and CC handling; provider-locked retries; mobile-ready details/copy, partial preservation, continuation and no storage/context leakage.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>w.close());
