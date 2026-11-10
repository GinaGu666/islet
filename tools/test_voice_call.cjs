// Test only: npm install --prefix /tmp/islet-tests playwright
// NODE_PATH=/tmp/islet-tests/node_modules node tools/test_voice_call.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({headless:true,executablePath:chromium.executablePath(),args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  try {
    const page = await browser.newPage({ viewport:{width:390,height:844} });
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.route('**/*', r=>r.abort());
    await page.route('https://islet.test/**', r=>r.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(__dirname,'../index.html'),'utf8')}));
    await page.goto('https://islet.test/',{waitUntil:'domcontentloaded'});
    await page.evaluate(() => {
      loadCompanions(); loadSessions(); selectedModel='test/model'; apiKey='test';
      localStorage.setItem('islet_memsrv_url','https://memory.test'); localStorage.setItem('islet_memsrv_key','test');
      showMain(); hide('setup-overlay'); renderAll(); openVoiceCall();
    });
    assert.equal(await page.locator('#voice-dialog').evaluate(e=>e.open),true);
    assert.equal(await page.locator('#voice-hold').isDisabled(),true);
    await page.screenshot({path:'/tmp/islet-voice-mobile.png'});
    const result = await page.evaluate(async () => {
      const c=voiceCall; c.ready=true; c.life=new AbortController(); c.busy=true; c.turn=1;
      c.audio={close:async()=>{}};
      const originalBuild=buildApiMessages, originalStream=streamCompletion, originalSpeak=voiceSpeak;
      let request, calls=0, reachedSecond;
      const second=new Promise(r=>reachedSecond=r);
      buildApiMessages=async (msgs,sid)=>{const out=await originalBuild(msgs,sid);request=out;return out;};
      streamCompletion=async (model,msgs,signal,onReason,onContent,onServed,opts)=>{
        if(!opts.voice || opts.tools)throw Error('call options');
        onContent('第一句话已经说完。第二句话还没说完。');
        return {ended:'done',finish:'stop'};
      };
      voiceSpeak=async (call,text)=>{
        calls++; if(calls===1)return;
        reachedSecond(); await new Promise((resolve,reject)=>call.abort.signal.addEventListener('abort',()=>reject(new Error('cancel')),{once:true}));
      };
      c.task=voiceAnswer(c,'刚才那句是什么意思？'); await second;
      const before=messages.filter(m=>m.role==='assistant'&&m.call).length;
      interruptVoiceCall(); await c.task;
      const assistant=messages.at(-1), persisted=JSON.parse(localStorage.getItem('islet_s_'+currentId)).at(-1);
      const tail=request.findLast(m=>m.role==='user')._tail;
      await closeVoiceCall();
      // A complete turn commits its full answer and remains in the same branch.
      openVoiceCall();const d=voiceCall;d.ready=true;d.life=new AbortController();d.busy=true;d.turn=1;
      voiceSpeak=async()=>{};
      d.task=voiceAnswer(d,'继续说吧');await d.task;
      const complete=messages.at(-1);await closeVoiceCall();
      openVoiceCall();const f=voiceCall;f.ready=true;f.life=new AbortController();f.busy=true;f.turn=1;
      const count=messages.length;voiceSpeak=async()=>{throw new Error('test synthesis failure');};
      f.task=voiceAnswer(f,'这句合成会失败');await f.task;
      const failed={added:messages.length-count,lastRole:messages.at(-1).role,busy:f.busy,status:$('voice-status').textContent};
      await closeVoiceCall();
      buildApiMessages=originalBuild;streamCompletion=originalStream;voiceSpeak=originalSpeak;
      return {before,assistant,persisted,complete,failed,tail,closed:!voiceCall,dialogClosed:!$('voice-dialog').open};
    });
    assert.equal(result.before,0,'draft must not be committed before playback');
    assert.equal(result.assistant.content,'第一句话已经说完。');
    assert.equal(result.assistant.call.interrupted,true);
    assert.deepEqual(result.assistant,result.persisted);
    assert.equal(result.complete.content,'第一句话已经说完。第二句话还没说完。');
    assert.equal(result.complete.call.interrupted,false);
    assert.equal(result.failed.added,1);assert.equal(result.failed.lastRole,'user');assert.equal(result.failed.busy,false);assert.match(result.failed.status,/语音未完成/);
    assert.match(result.tail,/语音通话/);assert(result.closed&&result.dialogClosed);
    const audioResult = await page.evaluate(async () => {
      const NativeSocket=window.WebSocket, nativeToken=voiceToken;
      const sent=[], samples=[], buffers=[]; let beforeFinalBuffers = -1, starts = 0;
      window.WebSocket=class {
        constructor(){this.readyState=1;setTimeout(()=>this.onopen(),0);}
        send(text){sent.push(JSON.parse(text));if(JSON.parse(text).text===''){
          setTimeout(()=>this.onmessage({data:JSON.stringify({audio:btoa(String.fromCharCode(0))})}),0);
          setTimeout(()=>this.onmessage({data:JSON.stringify({audio:btoa(String.fromCharCode(128,255))})}),60);
          setTimeout(()=>{beforeFinalBuffers=buffers.length;this.onmessage({data:JSON.stringify({audio:btoa(String.fromCharCode(127)),isFinal:true})});},120);
        }}
        close(){}
      };
      voiceToken=async()=> 'one-use-test';
      openVoiceCall();const c=voiceCall;c.life=new AbortController();c.abort=new AbortController();c.turn=7;c.voice='voice-test';
      c.audio={get currentTime(){return performance.now()/1000;},destination:{},
        createBuffer(channels,length,rate){const a=new Float32Array(length);buffers.push(a);return {duration:length/rate,getChannelData:()=>a};},
        createBufferSource(){return {connect(){},disconnect(){},start(){starts++;setTimeout(()=>{if(this.onended)this.onended();},5);},stop(){samples.push('stopped');}};},close:async()=>{}};
      await voiceSpeak(c,'你好呀。',7);
      const pcm=Array.from(buffers[0]);
      c.pcm=[-32768,32767];c.stt={send:json=>samples.push(JSON.parse(json))};voiceSendPcm(c,true);
      const packet=samples.at(-1);
      await closeVoiceCall();window.WebSocket=NativeSocket;voiceToken=nativeToken;
      return {pcm,sent,packet,beforeFinalBuffers,starts};
    });
    assert.deepEqual(audioResult.pcm,[-1,32767/32768]);
    assert.equal(audioResult.beforeFinalBuffers,0,'late network chunks must not cause playback gaps');
    assert.equal(audioResult.starts,1,'one continuous source per sentence');
    assert.equal(audioResult.sent[0].text,' ');
    assert.equal(audioResult.sent.at(-1).text,'');
    assert.equal(audioResult.packet.audio_base_64,'AID/fw==');
    assert.equal(audioResult.packet.commit,true);
    await page.evaluate(() => {
      window.voiceOriginals={token:voiceToken,answer:voiceAnswer,socket:WebSocket};
      window.voicePackets=[];window.heard='';
      voiceToken=async()=> 'test-token';
      voiceAnswer=async(c,text)=>{window.heard=text;c.busy=false;voiceButtons(c);};
      window.WebSocket=class {
        static OPEN=1;
        constructor(){this.readyState=1;setTimeout(()=>this.onmessage({data:JSON.stringify({message_type:'session_started'})}),0);}
        send(json){const p=JSON.parse(json);window.voicePackets.push(p);if(p.commit)setTimeout(()=>this.onmessage({data:JSON.stringify({message_type:'committed_transcript',text:'麦克风测试'})}),0);}
        close(){this.readyState=3;}
      };
      openVoiceCall();$('voice-id').value='voice-test';
    });
    await page.locator('#voice-connect').click();
    await page.waitForFunction(()=>voiceCall&&voiceCall.ready);
    await page.locator('#voice-hold').focus();
    await page.keyboard.down('Space');
    await page.waitForFunction(()=>voiceCall.sttReady);
    assert.equal(await page.locator('#voice-hold').isDisabled(),false,'hold control must receive release');
    await page.waitForFunction(()=>window.voicePackets.some(p=>!p.commit&&p.audio_base_64));
    await page.keyboard.up('Space');
    await page.waitForFunction(()=>window.heard==='麦克风测试');
    const cleanup=await page.evaluate(async()=>{
      const c=voiceCall,tracks=c.mic.getTracks();await closeVoiceCall();
      voiceToken=window.voiceOriginals.token;voiceAnswer=window.voiceOriginals.answer;window.WebSocket=window.voiceOriginals.socket;
      return {stopped:tracks.every(t=>t.readyState==='ended'),commits:window.voicePackets.filter(p=>p.commit).length};
    });
    assert(cleanup.stopped);assert.equal(cleanup.commits,1);
    assert.deepEqual(errors,[]);
    console.log('PASS: mobile dialog, draft isolation, played-only interruption, full playback, synthesis failure, PCM input/output, real AudioWorklet with fake microphone, release commit, track cleanup, context tail.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
