// node tools/test_tool_reasoning_carry.cjs — Fable tool rounds must carry thinking blocks back (else the whole prompt cache is rewritten).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
new vm.Script(source);
const parser = source.slice(source.indexOf('  function mergeReasoningDetail('), source.indexOf('  /* ---------- 模型路由提醒'));
const diagnostics = source.slice(source.indexOf('  function requestContext('), source.indexOf('  let routeController'));
const generate = source.slice(source.indexOf('  async function generateAssistant('), source.indexOf('  // 断点续写：'));
const max = Number(source.match(/const MAX_TOOL_ROUNDS = (\d+)/)[1]);
const noOp = () => {};
const element = () => ({ textContent: '', dataset: {}, classList: { add: noOp, remove: noOp } });


(async () => {
  // 思考显示打开时 onReason 要动界面计时器，这里的假界面不够用；带回思考块的代码两种情况走同一条路
  for (const reasoningEnabled of [false]) {
    const requests = [], shown = [];
    const h = { row: { dataset: {}, querySelector: () => ({ textContent: '10:32' }) }, textEl: element(), thinkEl: element(), thinkLbl: element(), thinkBody: element() };
    Object.defineProperty(h.thinkBody, 'textContent', { set: v => shown.push(v), get: () => shown.join('') });
    const context = vm.createContext({
      AbortController, TextDecoder, setInterval, clearInterval, performance,
      apiKey: 'test-only', webOn: false, reasoningEnabled, reasoningEffort: '', currentAbort: null,
      URL, location: {href:'https://mock.test/'}, localStorage:{getItem:()=>null},
      currentId: 'sid', activeCompanionId: 'test', selectedModel: 'anthropic/claude-fable-5.1',
      messages: [{ role: 'user', content: '记住我今天去了花园' }], sessions: [{ id: 'sid' }], MAX_TOOL_ROUNDS: max,
      $: () => ({ focus: noOp }), nowTime: () => '10:32',
      setLoading: value => { context.isLoading = value; }, addAi: () => h,
      toolsActive: () => true, modelSupportsTools: () => true, modelSupportsReasoning: () => true,
      activeToolDefs: () => [{ type: 'function', function: { name: 'remember', parameters: { type: 'object' } } }],
      withCacheBreakpoints: (_, messages) => messages, apiUrl: () => 'https://mock.test', authHeaders: () => ({}),
      applyModelRoute: payload => payload,
      buildApiMessages: async (messages, sid, extra) => [...messages, ...(extra || [])],
      makeServedHandler: (_, model, cb) => served => cb(served), baseModelId: x => x,
      scheduleRender: (h, text) => { h.textEl.textContent = text(); }, renderNow: (h, text) => { h.textEl.textContent = text; },
      delay: async () => {}, setReplyProvider: noOp, showBroken: noOp, logTool: noOp, saveCurrent: noOp, updateTokenBar: noOp,
      runTool: async () => ({ args: {}, result: '已记住', label: '记了一张卡' }),
      fetch: async (url, options) => {
        const payload = JSON.parse(options.body); requests.push(payload);
        const ev = requests.length === 1 ? [
          { choices: [{ delta: { reasoning: '想一想', reasoning_details: [{ type: 'reasoning.text', text: '想一', index: 0, format: 'anthropic-claude-v1' }] } }] },
          { choices: [{ delta: { reasoning: '', reasoning_details: [{ type: 'reasoning.text', text: '想', index: 0 }] } }] },
          { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', signature: 'SIG', index: 0 }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'remember', arguments: '{"text":"去了花园"}' } }] }, finish_reason: 'tool_calls' }] },
        ] : [{ choices: [{ delta: { content: '记住啦' }, finish_reason: 'stop' }] }];
        const sse = ev.map(e => 'data: ' + JSON.stringify({ model: 'anthropic/claude-fable-5.1', ...e }) + '\n\n').join('') + 'data: [DONE]\n';
        let sent = false;
        return { ok: true, body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from(sse) }) }) } };
      },
    });
    vm.runInContext(diagnostics + '\n' + parser + '\n' + generate, context);
    await context.generateAssistant();
    assert.equal(requests.length, 2);
    if (!reasoningEnabled) assert(!requests[0].reasoning || !requests[0].reasoning.exclude, 'Fable thinking must not be excluded, we need the blocks');
    const asst = requests[1].messages.find(m => m.role === 'assistant' && m.tool_calls);
    assert(asst, 'tool round assistant message present');
    assert.deepEqual(JSON.parse(JSON.stringify(asst.reasoning_details)), [{ type: 'reasoning.text', text: '想一想', index: 0, format: 'anthropic-claude-v1', signature: 'SIG' }]);
    if (!reasoningEnabled) assert(!shown.join('').includes('想一想'), 'thinking stays hidden when the user turned it off');
  }
  // 没有 index 的分片：同类型接到上一块后面
  const m = vm.createContext({}); vm.runInContext(source.slice(source.indexOf('  function mergeReasoningDetail('), source.indexOf('  async function streamCompletion(')), m);
  const list = []; for (const x of [{ type: 'reasoning.text', text: 'a' }, { type: 'reasoning.text', text: 'b' }, { type: 'reasoning.text', signature: 'S' }, { type: 'reasoning.encrypted', data: 'xyz' }]) m.mergeReasoningDetail(list, x);
  assert.deepEqual(JSON.parse(JSON.stringify(list)), [{ type: 'reasoning.text', text: 'ab', signature: 'S' }, { type: 'reasoning.encrypted', data: 'xyz' }]);
  console.log('tool reasoning carry: ok');
})().catch(e => { console.error(e); process.exit(1); });
