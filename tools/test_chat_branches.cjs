// Test-only dependencies (the app itself still has no dependencies):
// npm install --prefix /tmp/islet-tests jsdom fake-indexeddb
// NODE_PATH=/tmp/islet-tests/node_modules node tools/test_chat_branches.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const json = value => JSON.parse(JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const contexts = [];

async function app(storage, db = new IDBFactory()) {
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', e => { if (!e.message.includes('navigation')) errors.push(e.message); });
  const dom = new JSDOM(html, { url: 'https://islet.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  contexts.push(dom);
  const w = dom.window;
  w.indexedDB = db;
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.URL.createObjectURL = () => 'blob:islet-test';
  w.URL.revokeObjectURL = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = () => { throw new Error('Tests must not make API requests'); };
  for (const [key, value] of Object.entries(storage || {})) w.localStorage.setItem(key, value);
  const run = code => vm.runInContext(code, dom.getInternalVMContext());
  run(source);
  w.onload = null; // Initialize without model discovery or real API credentials.
  run(`
    uiPrompt = async () => globalThis.testName || '分支 A';
    uiConfirm = async () => true;
    uiAlert = async () => true;
    toast = text => { globalThis.lastToast = text; };
    downloadFile = (name, content) => { globalThis.download = { name, content }; };
    loadCompanions(); loadSessions();
    if (currentId) activeCompanionId = sessionCompanion(currentId).id;
    selectedModel = DEFAULT_MODEL;
    showMain(); renderAll();
  `);
  await sleep(30);
  return { dom, w, run, db, errors, storage: () => Object.fromEntries(Object.entries(w.localStorage)) };
}

function fixture() {
  const stamp = Date.now() - 86400000;
  const msgs = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'root-' + i, ts: stamp + i * 1000, time: '12:00' }));
  msgs[0].files = [{ id: 'shared-file', name: 'notes.txt', chars: 4 }];
  return {
    islet_companions: JSON.stringify([{ id: 'c1', name: '测试角色', persona: 'persona', cards: [{ id: 'k1', t: '共同记忆', d: stamp }], epis: [], autoDistill: false }]),
    islet_active_companion: 'c1', islet_cur: 'root-tail',
    islet_idx: JSON.stringify([
      { id: 'root-old', companionId: 'c1', first: stamp, updated: stamp + 3000, count: 4, distilled: 2 },
      { id: 'root-tail', companionId: 'c1', first: stamp + 4000, updated: stamp + 7000, count: 4, distilled: 2 },
    ]),
    'islet_s_root-old': JSON.stringify(msgs.slice(0, 4)),
    'islet_s_root-tail': JSON.stringify(msgs.slice(4)),
  };
}

async function texts(a) {
  return json(await a.run(`(async () => {
    const out = []; for (const s of riverChunks(activeCompanionId)) out.push(...await loadChunk(s.id));
    return out.map(m => m.content);
  })()`));
}
async function fork(a, ref, name = '分支 A') {
  a.w.testName = name;
  await a.run(`createChatBranch(${JSON.stringify(ref)})`);
  await sleep(30);
}

(async () => {
  const a = await app(fixture());
  await a.run(`filePut({ id: 'shared-file', name: 'notes.txt', text: 'data' })`);
  await a.run(`rebalanceChunks('c1')`); // Exercise real IndexedDB cold chunks.
  assert.equal(a.run(`activeBranchFor('c1')`), 'main');
  assert.deepEqual(await texts(a), Array.from({ length: 8 }, (_, i) => 'root-' + i));
  const originalTail = json(await a.run(`loadChunk('root-tail')`));

  await fork(a, { sid: 'root-tail', idx: 1 });
  const firstBranch = a.run(`activeBranchFor('c1')`);
  assert.notEqual(firstBranch, 'main');
  assert.deepEqual(await texts(a), Array.from({ length: 6 }, (_, i) => 'root-' + i));
  assert.deepEqual(json(await a.run(`loadChunk('root-tail')`)), originalTail);
  assert.equal(a.run(`riverTotal('c1')`), 6);
  assert.equal(a.w.document.querySelectorAll('#chat .msg').length, 2); // Latest inherited chunk is rendered.
  await a.run(`appendToRiver('c1', { role: 'user', content: 'branch-only', ts: Date.now(), time: '13:00' })`);
  a.run(`renderAll()`);
  const api = json(await a.run(`buildApiMessages(messages, currentId)`));
  assert(api.some(m => String(m.content).includes('branch-only')));
  assert(!api.some(m => /root-[67]/.test(String(m.content))));
  assert(a.w.document.getElementById('branch-label').textContent.includes('分支 A'));

  const inherited = a.run(`riverChunks('c1')[0].id`);
  await fork(a, { sid: inherited, idx: 1 }, '嵌套分支');
  assert.deepEqual(await texts(a), ['root-0', 'root-1']);
  const nestedBranch = a.run(`activeBranchFor('c1')`);
  a.run(`switchChatBranch('c1', 'main')`);
  assert.deepEqual(await texts(a), Array.from({ length: 8 }, (_, i) => 'root-' + i));
  a.run(`switchChatBranch('c1', ${JSON.stringify(firstBranch)})`);
  assert.equal((await texts(a)).at(-1), 'branch-only');
  assert.equal(a.run(`riverUpstream('root-tail')`), 4); // Request's branch, even when another is active.
  assert.deepEqual(json(await a.run(`riverTail('root-tail', 9)`)).map(m => m.content), ['root-0', 'root-1', 'root-2', 'root-3']);

  await a.run(`doSearch('root-7')`);
  assert(a.w.document.getElementById('search-results').textContent.includes('主线'));
  await a.run(`jumpToHit('root-tail', 3)`);
  await sleep(180);
  assert.equal(a.run(`activeBranchFor('c1')`), 'main');
  assert(a.w.document.querySelector('.msg[data-sid="root-tail"][data-midx="3"]'));

  // Storage failure after one copied chunk must roll back only staged chunks.
  const beforeFail = a.w.localStorage.getItem('islet_idx');
  const storesBefore = json(await a.run(`new Promise(async resolve => { const db = await idb(); const q = db.transaction('chunks').objectStore('chunks').getAllKeys(); q.onsuccess = () => resolve(q.result); })`));
  a.run(`globalThis.originalStoreCold = storeChunkCold; globalThis.copyCalls = 0;
    storeChunkCold = async (s, m) => ++globalThis.copyCalls === 2 ? false : originalStoreCold(s, m);`);
  await fork(a, { sid: 'root-tail', idx: 2 }, '写入失败');
  a.run(`storeChunkCold = originalStoreCold`);
  assert.equal(a.w.localStorage.getItem('islet_idx'), beforeFail);
  assert.equal(a.run(`activeBranchFor('c1')`), 'main');
  const storesAfter = json(await a.run(`new Promise(async resolve => { const db = await idb(); const q = db.transaction('chunks').objectStore('chunks').getAllKeys(); q.onsuccess = () => resolve(q.result); })`));
  assert.deepEqual(storesAfter, storesBefore);

  a.run(`globalThis.oldLsSet = lsSet; lsSet = (k, v) => k === 'islet_idx' ? false : oldLsSet(k, v);`);
  await fork(a, { sid: 'root-tail', idx: 0 }, '索引失败');
  a.run(`lsSet = oldLsSet`);
  assert.equal(a.w.localStorage.getItem('islet_idx'), beforeFail);
  assert.equal(a.run(`branchBusy`), false);

  // While an old branch is moving to IndexedDB, returning to it and writing
  // must keep the new hot copy; concurrent rebalance calls share one job.
  const racingFixture = fixture();
  const racingIndex = JSON.parse(racingFixture.islet_idx);
  racingIndex[0].branchId = 'prior';
  racingFixture.islet_idx = JSON.stringify(racingIndex);
  const race = await app(racingFixture);
  race.run(`globalThis.realPut = idbPut;
    globalThis.releaseMove = null;
    idbPut = async (store, rec) => {
      if (store === 'chunks' && rec.id === 'root-old') await new Promise(resolve => { globalThis.releaseMove = resolve; });
      return realPut(store, rec);
    };`);
  const moving = race.run(`rebalanceChunks('c1')`);
  assert.equal(race.run(`rebalanceChunks('c1') === rebalanceJobs.get('c1')`), true);
  race.run(`switchChatBranch('c1', 'prior')`);
  await race.run(`appendToRiver('c1', { role: 'user', content: 'saved-during-move', ts: Date.now() })`);
  race.run(`releaseMove()`);
  await moving;
  assert.equal(race.run(`sessions.find(s => s.id === 'root-old').cold || 0`), 0);
  assert.equal((await texts(race)).at(-1), 'saved-during-move');
  assert.equal(JSON.parse(race.w.localStorage.getItem('islet_s_root-old')).at(-1).content, 'saved-during-move');

  // Empty conversation has no transcript, but keeps the same shared memory.
  await fork(a, null, '空白');
  assert.deepEqual(await texts(a), []);
  assert.equal(a.run(`activeCompanion().cards[0].t`), '共同记忆');
  a.w.testName = '<新的名字>';
  await a.run(`renameChatBranch('c1', activeBranchFor('c1'))`);
  assert(a.w.document.querySelector('#branch-list').textContent.includes('<新的名字>'));
  assert(!a.w.document.querySelector('#branch-list 新的名字'));
  a.run(`hide('branch-overlay'); switchChatBranch('c1', ${JSON.stringify(nestedBranch)})`);

  // Delete one copied attachment message; other branches still need the file.
  a.run(`menuRef = { sid: riverChunks('c1')[0].id, idx: 0 }`);
  await a.run(`chunkMsgs(menuRef.sid)`);
  await a.run(`$('mm-del').onclick()`);
  assert(await a.run(`fileGet('shared-file')`));
  a.run(`switchChatBranch('c1', 'main')`);
  assert.equal((await texts(a))[0], 'root-0');

  // Backup includes all branches; exercise the actual file-import handler.
  a.run(`switchChatBranch('c1', ${JSON.stringify(firstBranch)})`);
  await a.run(`exportBackup()`);
  const exported = JSON.parse(a.w.download.content);
  assert(exported.sessions.some(s => s.branchId === firstBranch));
  assert(exported.sessions.some(s => !s.branchId));
  assert.equal(exported.attachments.files['shared-file'].text, 'data');
  assert(!('or_key' in exported.settings));
  const b = await app(fixture());
  const file = new b.w.File([a.w.download.content], 'backup.json', { type: 'application/json' });
  b.w.backupInput = { value: 'backup.json', files: [file] };
  b.run(`importBackup(backupInput)`);
  for (let i = 0; i < 100 && b.w.localStorage.getItem('islet_cur') !== exported.currentId; i++) await sleep(10);
  await sleep(30);
  b.run(`loadCompanions(); loadSessions(); activeCompanionId = sessionCompanion(currentId).id; enterCompanion(activeCompanionId); renderAll()`);
  await sleep(30);
  assert.equal(b.run(`activeBranchFor('c1')`), firstBranch);
  assert.equal((await texts(b)).at(-1), 'branch-only');
  assert.equal(b.run(`branchesOf('c1').length`), a.run(`branchesOf('c1').length`));
  assert.equal((await b.run(`fileGet('shared-file')`)).text, 'data');

  // Delete a parent branch while its child is active. Copies, shared memory,
  // shared attachments and the current rendered message menu must survive.
  const d = await app(fixture());
  await d.run(`filePut({ id: 'shared-file', name: 'notes.txt', text: 'data' })`);
  await fork(d, { sid: 'root-tail', idx: 1 }, '可删除的父分支');
  const parent = d.run(`activeBranchFor('c1')`);
  await d.run(`filePut({ id: 'child-file', name: 'child.txt', text: 'shared with child' })`);
  await d.run(`appendToRiver('c1', { role: 'user', content: 'child inherits this', ts: Date.now(), files: [{ id: 'child-file', name: 'child.txt' }] })`);
  const parentTail = d.run(`currentId`);
  await fork(d, { sid: parentTail, idx: 0 }, '保留的子分支');
  const child = d.run(`activeBranchFor('c1')`);
  d.run(`switchChatBranch('c1', ${JSON.stringify(parent)})`);
  await d.run(`filePut({ id: 'parent-file', name: 'parent.txt', text: 'delete me' }); imgPut({ id: 'parent-img', blob: 'synthetic image' })`);
  await d.run(`appendToRiver('c1', { role: 'user', content: 'parent exclusive', ts: Date.now(), files: [{ id: 'parent-file', name: 'parent.txt' }], imgs: ['parent-img'] })`);
  const parentIds = json(d.run(`riverChunks('c1').map(s => s.id)`));
  d.run(`switchChatBranch('c1', ${JSON.stringify(child)})`);
  await sleep(30);
  const childBefore = await texts(d), memoryBefore = json(d.run(`activeCompanion().cards`));
  d.run(`openBranches()`);
  assert.equal(d.w.document.querySelectorAll('#branch-list .branch-delete').length, 2);
  assert(!d.w.document.querySelector('[aria-label="删除分支主线"]'));

  // Cancel and failed metadata/index writes must retain all data.
  const beforeDelete = d.w.localStorage.getItem('islet_idx');
  const compBeforeDelete = d.w.localStorage.getItem('islet_companions');
  d.run(`uiConfirm = async () => false`);
  await d.run(`deleteChatBranch('c1', ${JSON.stringify(parent)})`);
  assert.equal(d.w.localStorage.getItem('islet_idx'), beforeDelete);
  d.run(`uiConfirm = async () => true; globalThis.beforeDeleteLsSet = lsSet; lsSet = (k, v) => k === 'islet_idx' ? false : beforeDeleteLsSet(k, v)`);
  await d.run(`deleteChatBranch('c1', ${JSON.stringify(parent)})`);
  assert.equal(d.w.localStorage.getItem('islet_idx'), beforeDelete);
  assert.equal(d.w.localStorage.getItem('islet_companions'), compBeforeDelete);
  d.run(`lsSet = (k, v) => k === 'islet_companions' ? false : beforeDeleteLsSet(k, v)`);
  await d.run(`deleteChatBranch('c1', ${JSON.stringify(parent)})`);
  assert.equal(d.w.localStorage.getItem('islet_idx'), beforeDelete);
  d.run(`lsSet = beforeDeleteLsSet`);

  await d.run(`deleteChatBranch('c1', ${JSON.stringify(parent)})`);
  assert.equal(d.run(`activeBranchFor('c1')`), child);
  assert(!d.run(`branchesOf('c1')`).some(x => x.id === parent));
  assert.deepEqual(await texts(d), childBefore);
  assert.deepEqual(json(d.run(`activeCompanion().cards`)), memoryBefore);
  assert(await d.run(`fileGet('shared-file')`));
  assert(await d.run(`fileGet('child-file')`));
  assert.equal(await d.run(`fileGet('parent-file')`), null);
  assert.equal(await d.run(`imgGet('parent-img')`), null);
  for (const id of parentIds) {
    assert.equal(d.w.localStorage.getItem('islet_s_' + id), null);
    assert.equal(await d.run(`idbGet('chunks', ${JSON.stringify(id)})`), null);
  }
  const childRow = d.w.document.querySelector('#chat .msg');
  assert(childRow);
  d.run(`showMsgMenu(${JSON.stringify(childRow.dataset.sid)}, ${childRow.dataset.midx})`);
  assert(d.w.document.getElementById('msgmenu-overlay').classList.contains('show'));

  // Deleting the current branch returns to main and survives a reload.
  await d.run(`deleteChatBranch('c1', ${JSON.stringify(child)})`);
  assert.equal(d.run(`activeBranchFor('c1')`), 'main');
  assert.deepEqual(await texts(d), Array.from({ length: 8 }, (_, i) => 'root-' + i));
  assert.equal(await d.run(`fileGet('child-file')`), null);
  assert(await d.run(`fileGet('shared-file')`));
  const onlyMainIndex = d.w.localStorage.getItem('islet_idx');
  await d.run(`deleteChatBranch('c1', 'main')`);
  assert.equal(d.w.localStorage.getItem('islet_idx'), onlyMainIndex);
  const reloaded = await app(d.storage(), d.db);
  assert.equal(reloaded.run(`branchesOf('c1').length`), 1);
  assert.equal(reloaded.run(`activeBranchFor('c1')`), 'main');
  assert.deepEqual(await texts(reloaded), Array.from({ length: 8 }, (_, i) => 'root-' + i));
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  assert.deepEqual(d.errors, []);
  assert.deepEqual(reloaded.errors, []);
  console.log('PASS: branching, deletion/cancellation/failure rollback, descendants, shared attachments/memory, active-branch fallback, reload, and backup/import.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { for (const dom of contexts) dom.window.close(); });
