'use strict';
// 自由时间读书用的两样工具：打开一个网页往下读（fetch_page）、在维基文库里搜古籍原文（wikisource_search）。
// 只读，不登录，不带任何钥匙。网页内容是资料，不是指令——外面由 server.js 再包一层说明。
// 防 SSRF：只许 http(s)，域名解析到内网 / 本机 / 保留地址一律拒绝，跳转也逐跳检查。

const dns = require('node:dns').promises;
const net = require('node:net');

const PAGE_CHARS = 6000;          // 一次给模型看的字数
const MAX_BYTES = 3 * 1024 * 1024;
const UA = 'islet-reader/1 (personal reading bot; contact via GitHub GinaGu666/islet)';
const ALLOW_LOCAL = process.env.READ_ALLOW_LOCAL === '1';   // 只给测试用

function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
function privateIp(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return privateV4(s.slice(7));
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
}
async function assertPublic(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只能打开 http / https 网址');
  if (ALLOW_LOCAL) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error('找不到这个网站'); });
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('这个地址不能打开');
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|dd|dt|blockquote|pre|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t\f\v\r]+/g, ' ').replace(/ *\n[ \n]*/g, '\n').trim();
}

async function fetchText(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (_) { throw new Error('网址不对'); }
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(u);
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location'), u); continue; }
    if (!res.ok) throw new Error('网页打不开（HTTP ' + res.status + '）');
    const type = res.headers.get('content-type') || '';
    if (!/text\/|html|xml|json/i.test(type)) throw new Error('这不是文字网页（' + type.split(';')[0] + '）');
    const reader = res.body.getReader(), chunks = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BYTES) { reader.cancel().catch(() => {}); break; } chunks.push(value); }
    const body = Buffer.concat(chunks).toString('utf8');
    const text = /html|xml/i.test(type) ? htmlToText(body) : body.replace(/\r/g, '');
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body) || [])[1];
    return { url: u.href, title: title ? htmlToText(title).slice(0, 120) : '', text };
  }
  throw new Error('跳转太多次');
}

async function fetchPage(args) {
  const start = Math.max(0, Math.floor(Number(args && args.start) || 0));
  const page = await fetchText(args && args.url);
  const part = page.text.slice(start, start + PAGE_CHARS);
  const end = start + part.length;
  return {
    url: page.url, title: page.title, start, end, total: page.text.length,
    more: end < page.text.length ? `还有 ${page.text.length - end} 字没看，想接着读就再调用一次，start=${end}` : '已经到结尾',
    text: part,
  };
}

async function wikisourceSearch(args) {
  const q = String(args && args.query || '').trim().slice(0, 100);
  if (!q) throw new Error('要给搜索词');
  const lang = /^(zh|en|ja|fr|de)$/.test(args && args.lang) ? args.lang : 'zh';
  const api = `https://${lang}.wikisource.org/w/api.php?action=query&list=search&format=json&srlimit=8&srsearch=` + encodeURIComponent(q);
  const page = await fetchText(api);
  let j; try { j = JSON.parse(page.text); } catch (_) { throw new Error('维基文库没回应'); }
  const hits = ((j.query && j.query.search) || []).map(h => ({
    title: h.title,
    url: `https://${lang}.wikisource.org/wiki/` + encodeURIComponent(h.title.replace(/ /g, '_')),
    snippet: htmlToText(String(h.snippet || '')).slice(0, 120),
  }));
  return { query: q, lang, hits, tip: hits.length ? '用 fetch_page 打开想读的那一篇' : '没搜到，换个说法或者去掉朝代、作者再搜' };
}

const TOOLS = [
  { type: 'function', function: { name: 'fetch_page', description: '打开一个网址，读它的正文（去掉了网页框架，只剩文字）。每次给 6000 字；长文想往下读，就用 start 接着读。搜索结果只给摘要，想读原文就用这个。',
    parameters: { type: 'object', properties: { url: { type: 'string' }, start: { type: 'integer', description: '从第几个字开始读，默认 0' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'wikisource_search', description: '在维基文库（公版古籍、诗文、经典译本的全文库）里搜篇目，返回标题和网址。中文古籍用 lang=zh，英文公版书用 lang=en。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, lang: { type: 'string', enum: ['zh', 'en', 'ja', 'fr', 'de'] } }, required: ['query'] } } },
];

async function runTool(name, argText) {
  let args = {};
  try { args = JSON.parse(argText || '{}'); } catch (_) { return { error: '参数不是 JSON' }; }
  try {
    if (name === 'fetch_page') return await fetchPage(args);
    if (name === 'wikisource_search') return await wikisourceSearch(args);
    return { error: '没有这个工具' };
  } catch (e) { return { error: String(e.message || e).slice(0, 200) }; }
}

module.exports = { TOOLS, runTool, htmlToText, privateIp };
