const assert = require('node:assert/strict');
process.env.ISLET_KEY = 'test-only-key-12345678901234567890';
const { server } = require('../server/server');
const nativeFetch=global.fetch;
(async()=>{
  let calls=[];
  global.fetch=async(url,init)=>{calls.push({url,init});return {ok:true,json:async()=>({token:'one-use-test'})};};
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port+'/voice/token';
  const request=(type,key=process.env.ISLET_KEY)=>nativeFetch(url,{method:'POST',headers:{'X-Islet-Key':key,'Content-Type':'application/json'},body:JSON.stringify({type})});
  try {
    assert.equal((await request('realtime_scribe','wrong')).status,401);
    assert.equal((await request('invalid')).status,400);
    assert.equal((await request('realtime_scribe')).status,503);
    process.env.ELEVENLABS_API_KEY='server-only-test';
    for(const type of ['realtime_scribe','tts_websocket']){
      const res=await request(type);assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
      assert.deepEqual(await res.json(),{token:'one-use-test'});
      const call=calls.at(-1);assert.equal(call.url,'https://api.elevenlabs.io/v1/single-use-token/'+type);
      assert.equal(call.init.headers['xi-api-key'],'server-only-test');assert.equal(call.init.body,undefined);
    }
    global.fetch=async()=>({ok:false});assert.equal((await request('tts_websocket')).status,502);
    global.fetch=async()=>({ok:true,json:async()=>({})});assert.equal((await request('tts_websocket')).status,502);
    console.log('PASS: authentication, token type allowlist, missing config, both upstream token types, no-store, no audio/body forwarding, upstream failure.');
  } finally { global.fetch=nativeFetch;await new Promise(r=>server.close(r)); }
})().catch(e=>{console.error(e);process.exitCode=1;});
