// Downloads the public NASA Physical Sciences Informatics (PSI) combustion records into nasa-data/:
//   nasa-data/records.json        the 24 combustion-science investigations (text fields and file lists trimmed)
//   nasa-data/tables/*.csv        every "Experimental table" CSV NASA publishes for them
//
//   npm run data:fetch            then: npm run data:build
//
// Source: https://psi.nasa.gov (NASA PSI repository API). The data is public (CC0-1.0 for most records).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'nasa-data');
const BASE = 'https://psi.nasa.gov/geode-py/ws';
const KEEP = ['accession', 'title', 'investigationAcronym', 'flightProgram', 'spaceProgram', 'investigationStartDate', 'investigationEndDate',
  'objective', 'approach', 'hypothesis', 'researchImpacts', 'description', 'researchArea', 'subResearchArea', 'experimentHardware',
  'managingNasaCenter', 'doi', 'licenseIdentifier', 'licenseName', 'projectType', 'proposalTitle', 'releaseDate'];

async function get(url, as = 'json') {
  let last;
  for (let a = 0; a < 4; a += 1) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'flamex-data/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return as === 'json' ? await r.json() : as === 'text' ? await r.text() : Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; await new Promise((ok) => setTimeout(ok, 1000 * 2 ** a)); }
  }
  throw new Error(`${url.split('?')[0]}: ${last.message}`);
}
const safe = (s) => s.replace(/[^\w .()-]+/g, '_');

const q = new URLSearchParams({ ffield: 'Research Area', fvalue: 'combustion science', size: '500', type: 'investigation' });
const hits = (await get(`${BASE}/repo/search?${q}`)).hits.hits.map((h) => h._source.Accession);
console.log(`${hits.length} combustion investigations`);
await mkdir(join(OUT, 'tables'), { recursive: true });

const records = [];
for (const acc of hits) {
  const d = await get(`${BASE}/repo/investigations/${encodeURIComponent(acc)}`);
  const rec = Object.fromEntries(KEEP.map((k) => [k, d[k] ?? '']));
  rec.contacts = (d.contacts || []).map((c) => ({ name: [c.firstName, c.lastName].filter(Boolean).join(' '), role: (c.roles || []).map((r) => r.annotationValue).filter(Boolean).join(', '), affiliation: c.affiliation || '' }));
  rec.publications = (d.publications || []).map((p) => ({ title: p.title || '', authors: p.authorList || '', doi: p.doi || '' })).filter((p) => p.title);
  rec.n_files = (d.added || []).length;
  rec.tables = [];
  for (const f of d.experimentalTable || []) {
    const qs = new URLSearchParams({ file: f.file_name, version: String(f.version || 1), redirect: 'false' });
    const url = (await get(`${BASE}/studies/${encodeURIComponent(acc)}/download?${qs}`, 'text')).trim().replace(/^"|"$/g, '');
    if (!/^https:\/\/[a-z0-9.-]+\.amazonaws\.com\//.test(url)) throw new Error(`unexpected download URL for ${f.file_name}`);
    const file = `${acc}__${safe(f.file_name)}`;
    await writeFile(join(OUT, 'tables', file), await get(url, 'buffer'));
    rec.tables.push({ file, name: f.file_name });
  }
  records.push(rec);
  console.log(`  ok  ${acc} ${rec.investigationAcronym || ''} (${rec.tables.length} table${rec.tables.length === 1 ? '' : 's'})`);
}
records.sort((a, b) => +a.accession.split('-')[1] - +b.accession.split('-')[1]);
await mkdir(dirname(join(OUT, 'records.json')), { recursive: true });
await writeFile(join(OUT, 'records.json'), JSON.stringify({ source: 'https://psi.nasa.gov', fetched: new Date().toISOString().slice(0, 10), records }, null, 1));
console.log('Done. Now run: npm run data:build');
