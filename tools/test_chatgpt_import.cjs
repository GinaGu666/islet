// Test dependencies only: npm install --prefix /tmp/islet-tests jsdom fake-indexeddb
// NODE_PATH=/tmp/islet-tests/node_modules node tools/test_chatgpt_import.cjs
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom'),{IDBFactory}=require('fake-indexeddb');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const script=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');new vm.Script(script);
const contexts=[],plain=x=>JSON.parse(JSON.stringify(x)),pause=()=>new Promise(r=>setTimeout(r,35));
const node=(id,parent,role,text,time=1700000000,extra={})=>({id,parent,message:{id,author:{role},create_time:time,content:{content_type:'text',parts:[text]},...extra}});
function conversation(id='conv',title='Sol') {
 return {id,title,create_time:1700000000,update_time:1700000010,current_node:'chosen',mapping:{root:{id:'root',parent:null,message:null},sys:node('sys','root','system','NEVER IMPORT'),u:node('u','sys','user','你好',1700000000),old:node('old','u','assistant','OLD VERSION',1700000001),chosen:node('chosen','u','assistant','选中的回复',1700000002)}};
}
async function app(storage,db=new IDBFactory()) {
 const errors=[],log=new VirtualConsole();log.on('jsdomError',e=>{if(!e.message.includes('navigation'))errors.push(e.message)});
 const dom=new JSDOM(html,{url:'https://islet.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:log});contexts.push(dom);const w=dom.window;
 w.indexedDB=db;w.matchMedia=()=>({matches:false,addEventListener(){}});w.HTMLElement.prototype.scrollIntoView=()=>{};w.fetch=()=>{throw Error('Import must not call external APIs')};
 for(const[k,v]of Object.entries(storage||{}))w.localStorage.setItem(k,v);
 const run=code=>vm.runInContext(code,dom.getInternalVMContext());run(script);w.onload=null;
 run(`uiConfirm=async()=>true;uiAlert=async(msg,opts)=>{globalThis.lastAlert={msg,opts}};toast=t=>{globalThis.lastToast=t};downloadFile=(name,content)=>{globalThis.download={name,content}};loadCompanions();loadSessions();showMain();renderAll();`);await pause();
 const a={w,run,db,errors,storage:()=>Object.fromEntries(Object.entries(w.localStorage))};
 a.file=async docs=>{w.qaFiles=docs.map((d,i)=>new w.File([typeof d==='string'?d:JSON.stringify(d)],'conversations'+i+'.json'));await run(`importCharacterFile({files:qaFiles,value:'selected'})`)};
 a.prepare=()=>run('selectGptImports(true);prepareGptImport()');
 a.import=async(name='GPT QA',target='')=>{w.qaName=name;w.qaTarget=target;run(`$('ci-name').value=qaName;$('ci-target').value=qaTarget;`);await run('runCharacterImport()');await pause()};
 a.msgs=async cid=>plain(await run(`(async()=>{const out=[];for(const s of riverChunks(${JSON.stringify(cid)}))out.push(...await loadChunk(s.id));return out})()`));return a;
}
(async()=>{
 const a=await app();a.w.qaConv=conversation();
 let parsed=plain(a.run('gptConversation(qaConv)'));assert.deepEqual(parsed.messages.map(m=>m.content),['你好','选中的回复']);assert.equal(parsed.messages[0].ts,1700000000000);
 a.w.qaConv.mapping.chosen.message.create_time=1700000002000;assert.equal(a.run('gptConversation(qaConv).messages[1].ts'),1700000002000);
 a.w.qaConv.current_node='missing';assert.throws(()=>a.run('gptConversation(qaConv)'),/不完整/);
 a.w.qaConv=conversation();delete a.w.qaConv.current_node;assert.throws(()=>a.run('gptConversation(qaConv)'),/当前路线/);
 delete a.w.qaConv.mapping.old;assert.equal(a.run('gptConversation(qaConv).messages.length'),2);
 a.w.qaConv.mapping.u.parent='chosen';a.w.qaConv.current_node='chosen';assert.throws(()=>a.run('gptConversation(qaConv)'),/循环/);
 const media=conversation('media');media.mapping.chosen.message.content={content_type:'multimodal_text',parts:['文字',{content_type:'image_asset_pointer',asset_pointer:'secret-image'}]};
 media.mapping.hidden=node('hidden','chosen','assistant','HIDDEN REASONING',1700000003,{channel:'analysis'});media.mapping.tool=node('tool','hidden','tool','TOOL RESULT');media.current_node='tool';
 a.w.qaConv=media;parsed=plain(a.run('gptConversation(qaConv)'));assert.equal(parsed.omitted,1);assert.equal(parsed.messages.length,2);assert(parsed.messages[1].content.includes('占位'));assert(!JSON.stringify(parsed).includes('secret-image'));
 await a.file([[conversation('one','<img src=x onerror=alert(1)>'),conversation('two','另一个窗口')]]);
 assert.equal(a.run('ciGptEntries.length'),2);assert.equal(a.run('ciGptEntries.filter(e=>e.selected).length'),0);assert.equal(a.w.document.querySelectorAll('#gpt-import-list img').length,0);
 a.run(`$('gpt-import-search').value='另一个';renderGptImports()`);assert.equal(a.w.document.querySelectorAll('#gpt-import-list input').length,1);
 a.run('ciGptEntries[0].selected=true;prepareGptImport()');assert.equal(a.run('ciData.conversations.length'),1);
 await a.import();const cid=a.run('activeCompanionId');let imported=await a.msgs(cid);assert.deepEqual(imported.map(m=>m.content),['你好','选中的回复']);assert(imported.every(m=>m.importKey));assert.equal(a.run(`companions.find(c=>c.id===activeCompanionId).hist.total`),2);
 const oldCount=a.run('sessions.length');await a.file([[conversation('one')]]);a.prepare();await a.import('',cid);assert(a.w.lastToast.includes('没有重复'));assert.equal(a.run('sessions.length'),oldCount);
 // A newer export adds only its genuinely new nodes after the previous history is cleared.
 const extended=conversation('one');extended.mapping.next=node('next','chosen','user','继续',1700000004);extended.mapping.end=node('end','next','assistant','新的后续',1700000005);extended.current_node='end';
 a.run('activeCompanion().hist.cleared=true;saveCompanions()');await a.file([[extended]]);a.prepare();await a.import('',cid);imported=await a.msgs(cid);assert.deepEqual(imported.map(m=>m.content),['你好','选中的回复','继续','新的后续']);assert.equal(a.run('activeCompanion().hist.total'),2);
 await a.run('exportBackup()');const backup=JSON.parse(a.w.download.content);assert(Object.values(backup.sessionMsgs).flat().filter(m=>m.importKey).length===4);
 const reload=await app(a.storage(),a.db);assert.deepEqual((await reload.msgs(cid)).map(m=>m.content),imported.map(m=>m.content));
 const restored=await app();restored.w.qaBackup={files:[new restored.w.File([JSON.stringify(backup)],'backup.json')],value:'x'};restored.run('importBackup(qaBackup)');await pause();await pause();restored.run('loadCompanions();loadSessions()');assert.deepEqual((await restored.msgs(cid)).map(m=>m.importKey),imported.map(m=>m.importKey));
 // Numbered files deduplicate conversations and prefer the latest exported selection.
 const multi=await app();const newer=conversation('same','新标题');newer.update_time=1800000000;
 await multi.file([[conversation('same')],{conversations:[newer,conversation('separate','另一段')]}]);assert.equal(multi.run('ciGptEntries.length'),2);assert.equal(multi.run('ciGptEntries[0].title'),'新标题');
 await multi.file(['not JSON']);assert(multi.w.lastToast.includes('有效 JSON'));assert.equal(multi.run('ciData'),null);
 await multi.file([{unexpected:true}]);assert(multi.w.lastToast.includes('请选择'));assert.equal(multi.run('ciGptEntries.length'),0);
 // DeepSeek exports: fragments instead of author.role, no current_node; take the newest fork, skip THINK/SEARCH.
 const ds={id:'ds1',title:'破庙',inserted_at:'2026-10-01T12:00:00+08:00',updated_at:'2026-10-01T12:05:00+08:00',mapping:{root:{id:'root',parent:null,children:['1'],message:null},'1':{id:'1',parent:'root',children:['2'],message:{files:[],inserted_at:'2026-10-01T12:00:00+08:00',fragments:[{type:'REQUEST',content:'在吗'}]}},'2':{id:'2',parent:'1',children:['3','5'],message:{files:[],inserted_at:'2026-10-01T12:00:05+08:00',fragments:[{type:'THINK',content:'SECRET'},{type:'RESPONSE',content:'在'}]}},'3':{id:'3',parent:'2',children:[],message:{files:[],inserted_at:'2026-10-01T12:01:00+08:00',fragments:[{type:'REQUEST',content:'OLD EDIT'}]}},'5':{id:'5',parent:'2',children:['6'],message:{files:[{id:'f'}],inserted_at:'2026-10-01T12:02:00+08:00',fragments:[{type:'REQUEST',content:'看图'}]}},'6':{id:'6',parent:'5',children:[],message:{files:[],inserted_at:'2026-10-01T12:02:05+08:00',fragments:[{type:'SEARCH',results:[]},{type:'RESPONSE',content:'看到了'}]}}}};
 const dsApp=await app();await dsApp.file([[ds]]);assert.equal(dsApp.run('ciGptEntries.length'),1);dsApp.w.qaDs=ds;parsed=plain(dsApp.run('deepseekConversation(qaDs)'));
 assert.deepEqual(parsed.messages.map(m=>m.role),['user','assistant','user','assistant']);assert.equal(parsed.omitted,1);assert(!JSON.stringify(parsed).includes('SECRET'));assert(!JSON.stringify(parsed).includes('OLD EDIT'));
 dsApp.prepare();assert.equal(dsApp.run('ciData.source'),'deepseek');await dsApp.import('小和尚');assert.equal((await dsApp.msgs(dsApp.run('activeCompanionId'))).length,4);
 // Actual DeepSeek export schema, with generic text/IDs only; never commit a user's original export.
 const dsFlat={id:'ds-flat',title:'DeepSeek QA',pinned:false,current_message_id:2,inserted_at:'2026-10-01T12:00:00+08:00',updated_at:'2026-10-01T12:05:00+08:00',messages:[
  {id:1,parent_id:null,role:'USER',status:'FINISHED',thinking_enabled:false,search_enabled:false,accumulated_token_usage:0,inserted_at:'2026-10-01T12:00:00.003+08:00',fragments:[{type:'REQUEST',content:'测试提问'}]},
  {id:2,parent_id:1,role:'ASSISTANT',status:'FINISHED',thinking_enabled:true,search_enabled:true,accumulated_token_usage:20,inserted_at:'2026-10-01T12:00:00.000+08:00',fragments:[{type:'THINK',content:'PRIVATE THOUGHT'},{type:'SEARCH',content:'SEARCH RESULT'},{type:'RESPONSE',content:'测试回复'}]}
 ]};
 const dsActual=await app();await dsActual.file([dsFlat]);assert.equal(dsActual.run('ciGptEntries.length'),1);dsActual.prepare();
 assert.equal(dsActual.run('ciData.source'),'deepseek');parsed=plain(dsActual.run('ciData.conversations[0]'));
 assert.deepEqual(parsed.messages.map(m=>[m.role,m.content]),[['user','测试提问'],['assistant','测试回复']]);
 assert.equal(parsed.messages[0].ts,Date.parse(dsFlat.messages[0].inserted_at));assert.deepEqual(parsed.messages.map(m=>m.importKey),['deepseek:ds-flat:1','deepseek:ds-flat:2']);
 await dsActual.import('DeepSeek QA');const dsCid=dsActual.run('activeCompanionId');const dsStored=await dsActual.msgs(dsCid);assert.deepEqual(dsStored.map(m=>m.content),['测试提问','测试回复']);assert.deepEqual(dsStored.map(m=>m.ts),dsFlat.messages.map(m=>Date.parse(m.inserted_at)));
 await dsActual.file([dsFlat]);dsActual.prepare();await dsActual.import('',dsCid);assert(dsActual.w.lastToast.includes('没有重复'));assert.equal((await dsActual.msgs(dsCid)).length,2);
 // Selected response beats a newer fork; array ordering and numeric/string IDs do not change the route.
 const fork=plain(dsFlat);fork.messages.push({...plain(dsFlat.messages[1]),id:3,inserted_at:'2026-10-01T12:04:00+08:00',fragments:[{type:'RESPONSE',content:'UNSELECTED NEWER REPLY'}]});fork.messages.reverse();fork.current_message_id='2';
 dsActual.w.qaDs=fork;assert.deepEqual(plain(dsActual.run('deepseekConversation(qaDs).messages.map(m=>m.content)')),['测试提问','测试回复']);
 delete fork.current_message_id;assert.throws(()=>dsActual.run('deepseekConversation(qaDs)'),/当前路线/);
 dsActual.w.qaDs=plain(dsFlat);delete dsActual.w.qaDs.current_message_id;assert.equal(dsActual.run('deepseekConversation(qaDs).messages.length'),2);
 dsActual.w.qaDs=plain(dsFlat);dsActual.w.qaDs.current_message_id=99;assert.throws(()=>dsActual.run('deepseekConversation(qaDs)'),/不完整/);
 dsActual.w.qaDs=plain(dsFlat);dsActual.w.qaDs.messages[1].parent_id=99;assert.throws(()=>dsActual.run('deepseekConversation(qaDs)'),/不完整/);
 dsActual.w.qaDs=plain(dsFlat);dsActual.w.qaDs.messages[0].parent_id=2;assert.throws(()=>dsActual.run('deepseekConversation(qaDs)'),/循环/);
 dsActual.w.qaDs=plain(dsFlat);dsActual.w.qaDs.messages.push(plain(dsFlat.messages[1]));assert.throws(()=>dsActual.run('deepseekConversation(qaDs)'),/重复/);
 dsActual.w.qaDs=plain(dsFlat);delete dsActual.w.qaDs.messages[1].fragments;assert.throws(()=>dsActual.run('deepseekConversation(qaDs)'),/内容片段/);
 // Attachment-only user messages retain a placeholder; unselected branches stay out of incremental imports.
 dsActual.w.qaDs=plain(dsFlat);dsActual.w.qaDs.messages[0].fragments=[];dsActual.w.qaDs.messages[0].files=[{id:'test-file'}];parsed=plain(dsActual.run('deepseekConversation(qaDs)'));assert.equal(parsed.omitted,1);assert(parsed.messages[0].content.includes('占位'));
 const dsNext=plain(dsFlat);dsNext.messages.push({...plain(dsFlat.messages[0]),id:4,parent_id:2,fragments:[{type:'REQUEST',content:'后续提问'}]},{...plain(dsFlat.messages[1]),id:5,parent_id:4,fragments:[{type:'RESPONSE',content:'后续回复'}]});dsNext.current_message_id=5;dsNext.updated_at='2026-10-01T12:10:00+08:00';
 dsActual.run('activeCompanion().hist.cleared=true;saveCompanions()');await dsActual.file([[dsFlat],{conversations:[dsNext]}]);assert.equal(dsActual.run('ciGptEntries.length'),1);dsActual.prepare();await dsActual.import('',dsCid);assert.deepEqual((await dsActual.msgs(dsCid)).map(m=>m.content),['测试提问','测试回复','后续提问','后续回复']);
 // Legacy converted files still import dates/cards and retain unknown dates as unknown.
 const legacy=await app();await legacy.file([{app:'islet-import',character:{name:'旧格式',cards:[{t:'旧卡',date:'2023-11-14'}]},conversations:[{messages:[{role:'user',content:'旧消息',ts:1700000000000}]}]}]);await legacy.import('旧格式');assert.equal(legacy.run('activeCompanion().cards[0].date'),'2023-11-14');
 // Large imports span cold chunks; repeat runs and write failures never alter existing content.
 function bigData(){return{app:'islet-import',character:{},conversations:[{messages:Array.from({length:1002},(_,i)=>({role:i%2?'assistant':'user',content:'message-'+i,ts:1600000000000+i,importKey:'qa:'+i}))}]}}
 const large=await app();await large.file([bigData()]);await large.import('Large');assert.equal((await large.msgs(large.run('activeCompanionId'))).length,1002);assert.equal(large.run('activeCompanion().hist.total'),1002);
 // Distinct GPT message IDs must survive even when text and timestamps happen to be identical.
 const repeated=await app();const repeating=conversation('repeat');repeating.mapping.second=node('second','chosen','assistant','选中的回复',1700000002);repeating.current_node='second';
 await repeated.file([[repeating]]);repeated.prepare();await repeated.import('Repeated');assert.equal((await repeated.msgs(repeated.run('activeCompanionId'))).length,3);
 async function failure(setup){const x=await app();const before=x.storage(),old=plain(x.run('companions')),idx=plain(x.run('sessions'));await x.file([bigData()]);x.run(setup);await x.import('Must roll back');assert.deepEqual(plain(x.run('companions')),old);assert.deepEqual(plain(x.run('sessions')),idx);assert.equal(x.w.localStorage.getItem('islet_idx'),before.islet_idx);assert.equal(x.w.localStorage.getItem('islet_companions'),before.islet_companions);assert(!x.w.lastAlert?.msg.startsWith('已导入'));assert.equal(x.run('ciBusy'),false);assert.equal(x.run('branchBusy'),false);assert((await x.run(`(async()=>{const db=await idb();return await new Promise((resolve,reject)=>{const tx=db.transaction(['chunks','imports']);const out=[];for(const s of ['chunks','imports']){const r=tx.objectStore(s).getAll();r.onsuccess=()=>out.push(...r.result)}tx.oncomplete=()=>resolve(out);tx.onerror=()=>reject(tx.error)})})()`)).length===0);return x}
 await failure(`const realCold=storeChunkCold;let writes=0;storeChunkCold=async(meta,msgs)=>{if(++writes===2)return false;return realCold(meta,msgs)}`);
 await failure(`const realPut=idbPut;idbPut=(store,rec)=>realPut(store,store==='imports'?{...rec,msgs:[]}:rec)`);
 await failure(`const realSet=lsSet;lsSet=(key,value)=>key==='islet_idx'?false:realSet(key,value)`);
 for(const x of [a,reload,restored,multi,legacy,large,dsApp,dsActual])assert.deepEqual(x.errors,[]);
 console.log('PASS: GPT active-path conversion, actual DeepSeek messages/current_message_id exports and legacy mappings, selected forks, malformed trees, text/media handling, safe window selection, multi-file exports, dedupe/incremental imports, legacy compatibility, 1002-message cold storage, reload/backup and staged-write/readback/index rollback.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>contexts.forEach(d=>d.window.close()));

