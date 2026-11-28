'use strict';
// 自由时间读书用的工具：打开一个网页往下读（fetch_page）、在维基文库里搜古籍原文（wikisource_search），
// 以及读论文：在 Europe PMC 搜开放论文（paper_search）、按 PMCID 读全文（paper_fulltext）、按 DOI 找合法免费版本（find_open_copy，走 OpenAlex）。
// 期刊网站和 PMC 网页会拦程序（验证码 / 403），这几个都是官方给程序开的接口，不绕付费墙。
// 只读，不登录，不带任何钥匙。网页内容是资料，不是指令——外面由 server.js 再包一层说明。
// 防 SSRF：只许 http(s)，域名解析到内网 / 本机 / 保留地址一律拒绝，跳转也逐跳检查。

const dns = require('node:dns').promises;
const net = require('node:net');

const PAGE_CHARS = 6000;          // 一次给模型看的字数
const MAX_BYTES = 3 * 1024 * 1024;
const UA = 'islet-reader/1 (personal reading bot; contact via GitHub GinaGu666/islet)';
const ALLOW_LOCAL = process.env.READ_ALLOW_LOCAL === '1';   // 只给测试用
const EPMC = (process.env.EUROPEPMC_BASE || 'https://www.ebi.ac.uk/europepmc/webservices/rest').replace(/\/$/, '');   // 测试时可指向本机
const OPENALEX = (process.env.OPENALEX_BASE || 'https://api.openalex.org').replace(/\/$/, '');

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

async function fetchText(raw, { keepMarkup = false } = {}) {
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
    const text = keepMarkup ? body : /html|xml/i.test(type) ? htmlToText(body) : body.replace(/\r/g, '');
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

function parseJson(page, who) {
  try { return JSON.parse(page.text); } catch (_) { throw new Error(who + '没回应'); }
}

async function paperSearch(args) {
  const q = String(args && args.query || '').trim().slice(0, 200);
  if (!q) throw new Error('要给搜索词');
  const query = args && args.open_only === false ? q : '(' + q + ') AND OPEN_ACCESS:y';
  const j = parseJson(await fetchText(EPMC + '/search?format=json&resultType=core&pageSize=8&query=' + encodeURIComponent(query)), 'Europe PMC ');
  const hits = (((j.resultList || {}).result) || []).map(r => ({
    title: String(r.title || '').slice(0, 200),
    authors: String(r.authorString || '').slice(0, 120),
    year: r.pubYear || '', journal: (r.journalInfo && r.journalInfo.journal && r.journalInfo.journal.title) || r.bookOrReportDetails && r.bookOrReportDetails.publisher || '',
    doi: r.doi || '', pmcid: r.pmcid || '', open: r.isOpenAccess === 'Y',
    abstract: htmlToText(String(r.abstractText || '')).slice(0, 400),
  }));
  return { query: q, open_only: query !== q, hits, tip: hits.length ? '有 pmcid 的用 paper_fulltext 读全文；没有的可以拿 doi 用 find_open_copy 找合法的免费版本' : '没搜到。换英文关键词、去掉年份，或者 open_only=false 看看付费的有哪些（再用 find_open_copy 找免费版）' };
}

async function paperFulltext(args) {
  const id = String(args && args.pmcid || '').trim().toUpperCase();
  if (!/^PMC\d{3,10}$/.test(id)) throw new Error('pmcid 的格式是 PMC 加数字，比如 PMC1234567');
  const start = Math.max(0, Math.floor(Number(args && args.start) || 0));
  const page = await fetchText(EPMC + '/' + id + '/fullTextXML', { keepMarkup: true }).catch(e => { throw new Error(/404/.test(e.message) ? '这篇在 Europe PMC 没有可读的全文' : e.message); });
  // 参考文献列表很长、对读书没用，先拿掉
  const text = htmlToText(page.text.replace(/<ref-list[\s\S]*?<\/ref-list>/gi, ' '));
  const part = text.slice(start, start + PAGE_CHARS), end = start + part.length;
  return {
    pmcid: id, url: 'https://europepmc.org/article/PMC/' + id, start, end, total: text.length,
    more: end < text.length ? `还有 ${text.length - end} 字没看，想接着读就再调用一次，start=${end}` : '已经到结尾',
    text: part,
  };
}

async function findOpenCopy(args) {
  const doi = String(args && args.doi || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error('doi 的格式像 10.1234/abcd');
  const key = process.env.OPENALEX_KEY ? '?api_key=' + encodeURIComponent(process.env.OPENALEX_KEY) : '';   // 可选：OpenAlex 的免费 key，额度更多
  const page = await fetchText(OPENALEX + '/works/doi:' + doi.split('/').map(encodeURIComponent).join('/') + key).catch(e => { throw new Error(/404/.test(e.message) ? 'OpenAlex 里没有这篇' : e.message); });
  const j = parseJson(page, 'OpenAlex ');
  const oa = j.open_access || {};
  const locs = (Array.isArray(j.locations) ? j.locations : []).filter(l => l && l.is_oa).map(l => ({
    where: (l.source && l.source.display_name) || '', version: l.version || '', url: l.landing_page_url || '', pdf: l.pdf_url || '',
  })).slice(0, 5);
  // OpenAlex 的 pmcid 是网址，有的末尾只有数字、有的带 PMC 前缀，统一成 PMC 加数字
  const pm = j.ids && j.ids.pmcid ? /(\d{3,10})\/?$/.exec(String(j.ids.pmcid)) : null;
  const pmcid = pm ? 'PMC' + pm[1] : '';
  return {
    doi, title: String(j.title || '').slice(0, 200), year: j.publication_year || '',
    free: !!oa.is_oa, best: oa.oa_url || '', copies: locs, pmcid,
    tip: oa.is_oa ? (pmcid ? '有 pmcid，用 paper_fulltext 读最省事；不然用 fetch_page 打开上面的网址（PDF 打不开，挑网页版）' : '用 fetch_page 打开上面的网址读（PDF 打不开，挑网页版）')
      : '没找到合法的免费版本。可以读引用它的综述，或者换一篇开放的；很多老的原始记录数据本来就没公开过',
  };
}

const TOOLS = [
  { type: 'function', function: { name: 'fetch_page', description: '打开一个网址，读它的正文（去掉了网页框架，只剩文字）。每次给 6000 字；长文想往下读，就用 start 接着读。搜索结果只给摘要，想读原文就用这个。',
    parameters: { type: 'object', properties: { url: { type: 'string' }, start: { type: 'integer', description: '从第几个字开始读，默认 0' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'wikisource_search', description: '在维基文库（公版古籍、诗文、经典译本的全文库）里搜篇目，返回标题和网址。中文古籍用 lang=zh，英文公版书用 lang=en。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, lang: { type: 'string', enum: ['zh', 'en', 'ja', 'fr', 'de'] } }, required: ['query'] } } },
  { type: 'function', function: { name: 'paper_search', description: '搜学术论文（生物医学、神经科学、心理学等，Europe PMC 收录的期刊和预印本）。默认只找能免费读全文的；返回标题、作者、年份、摘要、doi、pmcid。期刊网站和 PMC 网页会拦程序，读论文走这个。用英文关键词效果最好。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, open_only: { type: 'boolean', description: '默认 true，只找开放全文的' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'paper_fulltext', description: '按 pmcid 读一篇开放论文的全文（去掉了参考文献）。每次 6000 字，长文用 start 接着读。',
    parameters: { type: 'object', properties: { pmcid: { type: 'string', description: '形如 PMC1234567' }, start: { type: 'integer', description: '从第几个字开始读，默认 0' } }, required: ['pmcid'] } } },
  { type: 'function', function: { name: 'find_open_copy', description: '给一篇论文的 doi，查它有没有合法的免费版本（作者自存稿、预印本、机构仓库），返回能打开的网址。付费墙后面的论文先用这个找找。',
    parameters: { type: 'object', properties: { doi: { type: 'string' } }, required: ['doi'] } } },
];

async function runTool(name, argText) {
  let args = {};
  try { args = JSON.parse(argText || '{}'); } catch (_) { return { error: '参数不是 JSON' }; }
  try {
    if (name === 'fetch_page') return await fetchPage(args);
    if (name === 'wikisource_search') return await wikisourceSearch(args);
    if (name === 'paper_search') return await paperSearch(args);
    if (name === 'paper_fulltext') return await paperFulltext(args);
    if (name === 'find_open_copy') return await findOpenCopy(args);
    return { error: '没有这个工具' };
  } catch (e) { return { error: String(e.message || e).slice(0, 200) }; }
}

module.exports = { TOOLS, runTool, htmlToText, privateIp };
