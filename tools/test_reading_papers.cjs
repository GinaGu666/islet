// No dependencies or credentials: the paper tools (Europe PMC search / full text, OpenAlex open copies) against a local stub.
// node tools/test_reading_papers.cjs
const assert = require('node:assert/strict');
const http = require('node:http');

(async () => {
  const seen = [];
  const stub = http.createServer((req, res) => {
    seen.push(req.url);
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/epmc/search') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ resultList: { result: [{ title: 'Orbitofrontal neurons and reward', authorString: 'Rolls ET, Thorpe SJ', pubYear: '1996', journalInfo: { journal: { title: 'J Neurophysiol' } }, doi: '10.1152/jn.1996.75.5.1970', pmcid: 'PMC1234567', isOpenAccess: 'Y', abstractText: '<i>Single</i> neurons in the OFC responded to taste.' }] } }));
    }
    if (u.pathname === '/epmc/PMC1234567/fullTextXML') {
      res.setHeader('Content-Type', 'application/xml');
      return res.end('<article><front><article-title>OFC</article-title></front><body><sec><p>Neurons fired to the sight of food.</p></sec></body><back><ref-list><ref>Some reference 1999</ref></ref-list></back></article>');
    }
    if (u.pathname === '/epmc/PMC9999999/fullTextXML') { res.writeHead(404); return res.end(); }
    if (u.pathname.startsWith('/oa/works/doi:10.1152/')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ title: 'Orbitofrontal neurons', publication_year: 1996, ids: { pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/1234567' }, open_access: { is_oa: true, oa_url: 'https://repo.example/ofc' }, locations: [{ is_oa: true, landing_page_url: 'https://repo.example/ofc', pdf_url: 'https://repo.example/ofc.pdf', version: 'acceptedVersion', source: { display_name: 'Repo' } }, { is_oa: false, landing_page_url: 'https://journal.example/paywalled' }] }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + stub.address().port;
  Object.assign(process.env, { READ_ALLOW_LOCAL: '1', EUROPEPMC_BASE: base + '/epmc', OPENALEX_BASE: base + '/oa' });
  const { runTool, TOOLS } = require('../server/reading-tools.js');

  assert.deepEqual(TOOLS.map(t => t.function.name).slice(2), ['paper_search', 'paper_fulltext', 'find_open_copy']);

  const s = await runTool('paper_search', JSON.stringify({ query: 'orbitofrontal single neuron' }));
  assert.equal(s.hits[0].pmcid, 'PMC1234567');
  assert.equal(s.hits[0].journal, 'J Neurophysiol');
  assert.match(s.hits[0].abstract, /^Single neurons/);
  assert.match(decodeURIComponent(seen[0]), /OPEN_ACCESS:y/, 'open-only by default');
  await runTool('paper_search', JSON.stringify({ query: 'x', open_only: false }));
  assert(!/OPEN_ACCESS/.test(decodeURIComponent(seen[1])), 'open_only=false searches everything');

  const f = await runTool('paper_fulltext', JSON.stringify({ pmcid: 'pmc1234567' }));
  assert.match(f.text, /Neurons fired to the sight of food/);
  assert(!/Some reference/.test(f.text), 'reference list dropped');
  assert.equal(f.url, 'https://europepmc.org/article/PMC/PMC1234567');
  assert.match((await runTool('paper_fulltext', JSON.stringify({ pmcid: 'PMC9999999' }))).error, /没有可读的全文/);
  assert.match((await runTool('paper_fulltext', JSON.stringify({ pmcid: '12345' }))).error, /格式/);

  const o = await runTool('find_open_copy', JSON.stringify({ doi: 'https://doi.org/10.1152/jn.1996.75.5.1970' }));
  assert.equal(o.free, true);
  assert.equal(o.pmcid, 'PMC1234567');
  assert.equal(o.copies.length, 1, 'only open locations');
  assert.equal(o.copies[0].url, 'https://repo.example/ofc');
  assert.match((await runTool('find_open_copy', JSON.stringify({ doi: '10.9999/nope' }))).error, /没有这篇/);
  assert.match((await runTool('find_open_copy', JSON.stringify({ doi: 'abc' }))).error, /格式/);

  stub.close();
  console.log('reading papers: ok');
})().catch(e => { console.error(e); process.exit(1); });
