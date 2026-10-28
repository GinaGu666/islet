// node tools/test_tool_round_limit.cjs — actual streaming parser and generation loop, mocked network/UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
new vm.Script(source);
const parser = source.slice(source.indexOf('  async function streamCompletion('), source.indexOf('  /* ---------- 模型路由提醒'));
const diagnostics = source.slice(source.indexOf('  function requestContext('), source.indexOf('  let routeController'));
const generate = source.slice(source.indexOf('  async function generateAssistant('), source.indexOf('  // 断点续写：'));
const max = Number(source.match(/const MAX_TOOL_ROUNDS = (\d+)/)[1]);
const noOp = () => {};
const element = () => ({ textContent: '', dataset: {}, classList: { add: noOp, remove: noOp } });

async function scenario({ needed = max, ignoreNone = false, parallel = 1, abortAt = 0, tools = true, finish = 'stop' } = {}) {
  const requests = [], executed = [], broken = [], labels = [];
  const h = { row: { dataset: {}, querySelector: () => ({ textContent: '10:32' }) }, textEl: element(), thinkEl: element(), thinkLbl: element(), thinkBody: element() };
  const context = vm.createContext({
    AbortController, TextDecoder, setInterval, clearInterval, performance,
    apiKey: 'test-only', webOn: false, reasoningEnabled: false, currentAbort: null,
    URL, location: {href:'https://mock.test/'}, localStorage:{getItem:()=>null},
    currentId: 'sid', activeCompanionId: 'test', selectedModel: 'anthropic/claude-fable-5.1',
    messages: [{ role: 'user', content: 'Please inspect the branch code.' }], sessions: [{ id: 'sid' }], MAX_TOOL_ROUNDS: max,
    $: () => ({ focus: noOp }), nowTime: () => '10:32',
    setLoading: value => { context.isLoading = value; }, addAi: () => h,
    toolsActive: () => tools, modelSupportsTools: () => true, modelSupportsReasoning: () => false,
    activeToolDefs: () => [{ type: 'function', function: { name: 'read_github', parameters: { type: 'object' } } }],
    withCacheBreakpoints: (_, messages) => messages, apiUrl: () => 'https://mock.test', authHeaders: () => ({}),
    applyModelRoute: payload => payload, routeError: message => message,
    buildApiMessages: async (messages, sid, extra) => [...messages, ...extra],
    makeServedHandler: (_, model, cb) => served => cb(served), baseModelId: x => x,
    scheduleRender: (h, text) => { h.textEl.textContent = text(); }, renderNow: (h, text) => { h.textEl.textContent = text; },
    setReplyProvider: noOp,
    showBroken: (h, a, b, label) => broken.push(label), logTool: (h, label) => labels.push(label),
    saveCurrent: noOp, updateTokenBar: noOp,
    runTool: async (call, sid, h, signal) => {
      executed.push(call.id);
      if (abortAt && executed.length === abortAt) context.currentAbort.abort();
      return { args: {}, result: 'source-' + call.id, label: 'Read ' + call.id };
    },
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body); requests.push(payload);
      const round = requests.length;
      const call = tools && round <= needed && (ignoreNone || payload.tool_choice !== 'none');
      const delta = call ? {
        ...(round === 1 ? { content: 'I will inspect it.' } : {}),
        tool_calls: Array.from({ length: parallel }, (_, i) => ({ index: i, id: 'call-' + round + '-' + i, type: 'function', function: { name: 'read_github', arguments: '{"path":"index.html"}' } })),
      } : { content: 'Summary of the code actually read; unread portions remain.' };
      const sse = 'data: ' + JSON.stringify({ model: context.selectedModel, choices: [{ delta, finish_reason: call ? 'tool_calls' : finish }] }) + '\n\ndata: [DONE]\n';
      let sent = false;
      return { ok: true, body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from(sse) }) }) } };
    },
  });
  vm.runInContext(diagnostics + '\n' + parser + '\n' + generate, context);
  await context.generateAssistant();
  return { context, requests, executed, broken, labels, h };
}

(async () => {
  const capped = await scenario();
  assert.equal(capped.requests.length, max + 1);
  assert.equal(capped.executed.length, max);
  assert(capped.requests.slice(0, max).every(r => r.tool_choice === 'auto'));
  const final = capped.requests.at(-1);
  assert.equal(final.tool_choice, 'none');
  assert(final.tools.some(t => t.function.name === 'read_github'), 'keep schemas for tool history validation');
  assert.equal(final.messages.filter(m => m.role === 'tool').length, max);
  assert(final.messages.at(-1).content.includes('尚未查看'));
  assert.equal(final.messages.at(-1).role, 'user');
  const ids = final.messages.flatMap(m => m.tool_calls || []).map(t => t.id);
  assert.deepEqual(ids, final.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  assert(capped.h.textEl.textContent.includes('Summary of the code actually read'));
  assert.equal(capped.context.messages.at(-1).tools.length, max);
  assert.equal(capped.context.isLoading, false);
  assert.deepEqual(capped.broken, []);

  const ordinary = await scenario({ needed: 2 });
  assert.equal(ordinary.requests.length, 3); assert.equal(ordinary.requests.at(-1).tool_choice, 'auto');
  assert.deepEqual(ordinary.broken, []);
  const multi = await scenario({ parallel: 2 });
  assert.equal(multi.executed.length, max * 2);
  assert.equal(multi.requests.at(-1).messages.filter(m => m.role === 'tool').length, max * 2);
  assert.deepEqual(multi.broken, []);

  const stubborn = await scenario({ needed: 999, ignoreNone: true });
  assert.equal(stubborn.requests.length, max + 1);
  assert.equal(stubborn.executed.length, max, 'never execute a sixth round even if upstream ignores none');
  assert(stubborn.labels.some(l => l.includes('本轮工具调用已达上限')));
  assert.equal(stubborn.context.messages.at(-1).tools.at(-1).name, 'tool_limit');
  assert.deepEqual(stubborn.broken, [], 'never mislabel tool handoff as upstream termination');

  const aborted = await scenario({ abortAt: 2 });
  assert.equal(aborted.requests.length, 2); assert.equal(aborted.executed.length, 2);
  assert.equal(aborted.context.isLoading, false); assert.deepEqual(aborted.broken, []);
  const noTools = await scenario({ tools: false });
  assert.equal(noTools.requests.length, 1); assert(!noTools.requests[0].tools);
  assert.equal(noTools.executed.length, 0);
  const length = await scenario({ needed: 0, finish: 'length' });
  assert.deepEqual(length.broken, ['达到长度上限']);
  console.log('PASS: five-round tool chains summarize with tool_choice:none, schemas and exact tool results preserved; ordinary/parallel tools, uncooperative upstream, cancellation, tools-off and length-limit behavior.');
})().catch(e => { console.error(e); process.exitCode = 1; });
