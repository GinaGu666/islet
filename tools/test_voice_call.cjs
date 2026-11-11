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
      const originalBuild=buildApiMessages, originalStream=streamCompletion, originalSpeak=voiceSpeak, originalPrepare=voicePrepare;
      voicePrepare=()=>({played:Promise.resolve(),play:async()=>{}});
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
      buildApiMessages=originalBuild;streamCompletion=originalStream;voiceSpeak=originalSpeak;voicePrepare=originalPrepare;
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
    const prefetchResult = await page.evaluate(async () => {
      const originalStream=streamCompletion, originalPrepare=voicePrepare;
      const prepared=[], started=[], cancelled=[];
      let finishFirst, secondReady;
      const ready=new Promise(r=>secondReady=r);
      streamCompletion=async(model,msgs,signal,onReason,onContent)=>{
        onContent('第一句话播放中。第二句话已预取。第三句话不要预取。');
        return {ended:'done',finish:'stop'};
      };
      voicePrepare=(c,text)=>{
        prepared.push(text);
        let resolve, reject;
        const played=new Promise((a,b)=>{resolve=a;reject=b;});played.catch(()=>{});
        c.abort.signal.addEventListener('abort',()=>{cancelled.push(text);reject(new Error('cancel'));},{once:true});
        return {played,play(){
          started.push(text);
          if(started.length===1){finishFirst=resolve;}else{secondReady();}
          return played;
        }};
      };
      openVoiceCall();const c=voiceCall;c.ready=true;c.life=new AbortController();c.busy=true;c.turn=1;
      c.task=voiceAnswer(c,'说三句话');
      while(prepared.length<2)await new Promise(r=>setTimeout(r,0));
      const before={prepared:prepared.slice(),started:started.slice()};
      finishFirst();await ready;
      const after={prepared:prepared.slice(),started:started.slice()};
      interruptVoiceCall();await c.task;
      const saved=messages.at(-1);
      await closeVoiceCall();
      streamCompletion=originalStream;voicePrepare=originalPrepare;
      return {before,after,saved,cancelled};
    });
    assert.deepEqual(prefetchResult.before.prepared,['第一句话播放中。','第二句话已预取。']);
    assert.deepEqual(prefetchResult.before.started,['第一句话播放中。']);
    assert.deepEqual(prefetchResult.after.prepared,['第一句话播放中。','第二句话已预取。','第三句话不要预取。']);
    assert.equal(prefetchResult.saved.content,'第一句话播放中。');
    assert.equal(prefetchResult.saved.call.interrupted,true);
    assert(prefetchResult.cancelled.includes('第三句话不要预取。'));
    const audioResult = await page.evaluate(async () => {
      const NativeSocket=window.WebSocket, nativeToken=voiceToken;
      const sent=[], samples=[], buffers=[]; let beforeFinalBuffers = -1, starts = 0; const startTimes = [];
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
        createBufferSource(){return {connect(){},disconnect(){},start(at){starts++;startTimes.push(at);setTimeout(()=>{if(this.onended)this.onended();},5);},stop(){samples.push('stopped');}};},close:async()=>{}};
      await voiceSpeak(c,'你好呀。',7);
      const pcm=buffers.flatMap(a=>Array.from(a));
      // A real prefetched socket may finish receiving PCM without scheduling any source.
      const previousStarts=starts;
      const ahead=voicePrepare(c,'提前取但不要播放。',7);
      await new Promise(r=>setTimeout(r,160));
      const bufferedStarts=starts-previousStarts;
      c.turn++;c.abort.abort();
      let cancelled=false;try{await ahead.play();}catch(_){cancelled=true;}
      const lateStarts=starts-previousStarts;

      c.pcm=[-32768,32767];c.stt={send:json=>samples.push(JSON.parse(json))};voiceSendPcm(c,true);
      const packet=samples.at(-1);
      await closeVoiceCall();window.WebSocket=NativeSocket;voiceToken=nativeToken;
      return {pcm,sent,packet,beforeFinalBuffers,starts,startTimes,bufferedStarts,lateStarts,cancelled};
    });
    assert.deepEqual(audioResult.pcm,[-1,32767/32768]);
    assert.equal(audioResult.beforeFinalBuffers,1,'start before final audio arrives');
    assert.equal(audioResult.starts,2);
    assert.equal(audioResult.bufferedStarts,0,'prefetch must buffer without playing');
    assert.equal(audioResult.lateStarts,0,'cancelled prefetch must never play');
    assert(audioResult.cancelled);
    assert(Math.abs(audioResult.startTimes[1]-audioResult.startTimes[0]-1/24000)<1e-8,'jitter buffer schedules chunks contiguously');
    assert.equal(audioResult.sent[0].text,' ');
    assert.equal(audioResult.sent.at(-1).text,'');
    assert.equal(audioResult.packet.audio_base_64,'AID/fw==');
    assert.equal(audioResult.packet.commit,true);
    await page.evaluate(() => {
      window.voiceOriginals={token:voiceToken,answer:voiceAnswer,socket:WebSocket};
      window.voicePackets=[];window.heard='';window.captureTracks=[];window.routeHistory=[];
      const session={_type:'auto',get type(){return this._type;},set type(value){this._type=value;window.routeHistory.push(value);}};
      Object.defineProperty(navigator,'audioSession',{configurable:true,value:session});
      voiceToken=async()=> 'test-token';
      voiceAnswer=async(c,text)=>{if(c.mic||window.captureTracks.some(t=>t.readyState!=='ended')||navigator.audioSession.type!=='playback')throw Error('microphone still active during playback');window.heard=text;c.busy=false;voiceButtons(c);};
      window.WebSocket=class {
        static OPEN=1;
        constructor(){this.readyState=1;setTimeout(()=>this.onmessage({data:JSON.stringify({message_type:'session_started'})}),0);}
        send(json){const p=JSON.parse(json);window.voicePackets.push(p);if(p.commit)setTimeout(()=>this.onmessage({data:JSON.stringify({message_type:'committed_transcript',text:'麦克风测试'})}),0);}
        close(){this.readyState=3;}
      };
      window.originalGetUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async constraints=>{if(navigator.audioSession.type==='playback')throw Error('capture in playback mode');window.micConstraints=constraints;const stream=await window.originalGetUserMedia(constraints);window.captureTracks.push(...stream.getTracks());return stream;};
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
    // Reacquire for the next utterance, then release again before answering.
    await page.evaluate(()=>{window.heard='';});
    await page.keyboard.down('Space');
    await page.waitForFunction(()=>voiceCall.sttReady);
    await page.keyboard.up('Space');
    await page.waitForFunction(()=>window.heard==='麦克风测试');
    // A late permission result after cancel/hangup must be stopped, not attached.
    await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{window.releasePendingMic=resolve;});});
    await page.keyboard.down('Space');
    await page.waitForFunction(()=>!!window.releasePendingMic);
    await page.keyboard.up('Space');
    const lateStopped=await page.evaluate(async()=>{
      await closeVoiceCall();let stopped=false;
      window.releasePendingMic({getTracks:()=>[{stop(){stopped=true;}}]});
      await new Promise(r=>setTimeout(r,20));return stopped;
    });
    assert(lateStopped,'late capture after hangup is released');
    const cleanup=await page.evaluate(async()=>{
      const tracks=window.captureTracks;await closeVoiceCall();
      voiceToken=window.voiceOriginals.token;voiceAnswer=window.voiceOriginals.answer;window.WebSocket=window.voiceOriginals.socket;
      navigator.mediaDevices.getUserMedia=window.originalGetUserMedia;
      return {mode:navigator.audioSession.type,routes:window.routeHistory,constraints:window.micConstraints,stopped:tracks.every(t=>t.readyState==='ended'),commits:window.voicePackets.filter(p=>p.commit).length};
    });
    assert(cleanup.stopped);assert.equal(cleanup.commits,2);
    assert.equal(cleanup.mode,'auto');assert(cleanup.routes.includes('playback'));
    assert(cleanup.routes.filter(x=>x==='auto').length>=2);
    for(const key of ['echoCancellation','noiseSuppression','autoGainControl'])assert.equal(cleanup.constraints.audio[key],false);
    assert.deepEqual(errors,[]);
    console.log('PASS: mobile dialog, draft isolation, played-only interruption, full playback, synthesis failure, PCM input/output, real AudioWorklet with fake microphone, release commit, track cleanup, context tail.');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
