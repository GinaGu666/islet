// No dependencies or credentials: exercise the real helper and tool dispatcher with mocked HTTP.
// node tools/test_github_read.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
new vm.Script(script);
let data, status = 200, calls = [], labels = [];
const file = text => ({ type: 'file', sha: 'test-sha', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });
const context = vm.createContext({
  AbortController, TextDecoder, Uint8Array, atob, setTimeout, clearTimeout,
  sessionCompanion: () => ({ id: 'test', name: '测试角色' }),
  logTool: (_, label) => labels.push(label),
  fetch: async (url, options) => { calls.push({ url, options }); return { ok: status === 200, status, json: async () => data }; },
});
vm.runInContext(script.slice(script.indexOf('  const TOOL_DEFS = ['), script.indexOf('  const NOTION_TOOL_URL')), context);
vm.runInContext(script.slice(script.indexOf('  async function readGitHub('), script.indexOf('  function logTool(')), context);
vm.runInContext(script.slice(script.indexOf('  async function runTool('), script.indexOf('  /* ---------- 流式核心')), context);
const read = args => context.readGitHub(args);
const plain = x => JSON.parse(JSON.stringify(x));

(async () => {
  assert(vm.runInContext(`TOOL_DEFS.some(t => t.function.name === 'read_github')`, context));
  data = file('第一行\r\nconst value = 42;\r\n最后一行');
  const first = await read({ path: 'index.html', line_count: 2, ref: 'feature/read code' });
  assert.equal(first.content, '1: 第一行\n2: const value = 42;');
  assert.equal(first.total_lines, 3);
  assert.equal(first.next.start_line, 3);
  assert.equal(first.next.ref, 'feature/read code');
  const last = await read(plain(first.next));
  assert.equal(last.content, '3: 最后一行');
  assert.equal(last.next, null);
  const request = calls[0];
  assert.equal(request.url, 'https://api.github.com/repos/GinaGu666/islet/contents/index.html?ref=feature%2Fread%20code');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.deepEqual(Object.keys(request.options.headers), ['Accept']);

  // Reassemble a very long line over multiple pages: no silent truncation or missing characters.
  const long = '甲😀'.repeat(13000);
  data = file(long + '\nEND');
  let args = { path: 'large.txt' }, restored = '', seen = 0;
  while (args) {
    const page = await read(args);
    assert(page.content.length < 14100);
    for (const row of page.content.split('\n')) {
      const match = row.match(/^(\d+)(?:（续，自第 \d+ 列）)?: (.*)$/);
      assert(match);
      if (match[1] === '1') restored += match[2];
      else assert.equal(match[2], 'END');
    }
    args = page.next; assert(++seen < 10);
  }
  assert.equal(restored, long);

  data = file(Array.from({ length: 45 }, (_, i) => 'function KEY_' + i + '() {}').join('\n'));
  const search = await read({ path: 'code.js', query: 'key_' });
  assert.equal(search.type, 'search'); assert.equal(search.total_matches, 45);
  assert.equal(search.matches.length, 20); assert.equal(search.next.start_line, 21);
  const search2 = await read(plain(search.next));
  assert.equal(search2.matches[0].line, 21); assert.equal(search2.next.query, 'key_');
  assert.equal((await read({ path: 'code.js', query: 'absent' })).matches.length, 0);
  assert.equal((await read({ path: 'code.js', query: 'absent' })).next, null);

  data = [{ type: 'file', path: 'index.html' }, { type: 'dir', path: 'tools' }];
  const directory = await read({ path: '', line_count: 1 });
  assert.equal(directory.type, 'directory'); assert.equal(directory.entries[0].path, 'index.html');
  assert.equal((await read(plain(directory.next))).entries[0].path, 'tools');
  data = []; assert.equal((await read({ path: '' })).next, null);

  const before = calls.length;
  for (const invalid of [{ path: '../secret' }, { path: 'https://evil.test/file' }, { path: 'a\\b' }, { path: '/a' }, { path: 'a//b' }, { path: 'a', repository: 'https://github.com/user/repo' }, { path: 'a', start_line: -1 }, { path: 'a', line_count: 0 }, { path: 'a', start_column: 1.5 }, {}]) {
    await assert.rejects(read(invalid));
  }
  assert.equal(calls.length, before, 'invalid parameters never make requests');
  data = file('x');
  await assert.rejects(read({ path: 'a', start_line: 2 }), /超出/);
  await assert.rejects(read({ path: 'a', start_column: 3 }), /超出/);
  data = file('\0binary'); await assert.rejects(read({ path: 'image.bin' }), /二进制/);
  data = { ...file('x'), size: 1024 * 1024 + 1 }; await assert.rejects(read({ path: 'huge' }), /1 MB/);
  data = { ...file('x'), encoding: 'none' }; await assert.rejects(read({ path: 'huge' }), /1 MB/);
  data = { type: 'symlink' }; await assert.rejects(read({ path: 'link' }), /普通文件/);
  data = { ...file('x'), submodule_git_url: 'https://elsewhere.test/repo' }; await assert.rejects(read({ path: 'submodule' }), /普通文件/);
  for (const code of [403, 404, 429, 500]) {
    status = code;
    const r = await context.runTool({ name: 'read_github', args: JSON.stringify({ path: 'index.html' }) }, 'sid', {});
    assert(r.result.startsWith('工具执行出错：'));
    assert(r.label.startsWith('GitHub 读取未完成：'));
  }
  status = 200; data = file('<script>alert("untrusted");</script>');
  const result = await context.runTool({ name: 'read_github', args: '{"path":"index.html"}' }, 'sid', {});
  assert(JSON.parse(result.result).content.includes('<script>'));
  assert(result.label.includes('读了 GitHub'));

  // User cancellation and timeout both stop the pending network request.
  context.fetch = (_, opts) => new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    if (opts.signal.aborted) abort(); else opts.signal.addEventListener('abort', abort, { once: true });
  });
  const controller = new AbortController();
  const pending = context.readGitHub({ path: 'index.html' }, controller.signal);
  controller.abort(); await assert.rejects(pending, /已取消/);
  context.setTimeout = callback => setTimeout(callback, 1);
  await assert.rejects(read({ path: 'index.html' }), /超时/);
  console.log('PASS: GitHub read/dispatch, Unicode and long-line pagination, keyword lookup, directories, anonymous GET only, invalid paths, HTTP failures, binary/large files, cancellation and timeout.');
})().catch(e => { console.error(e); process.exitCode = 1; });
