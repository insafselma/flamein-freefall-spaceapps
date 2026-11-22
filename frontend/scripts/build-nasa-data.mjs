// Converts the NASA PSI downloads in nasa-data/ into the JSON the public site reads (public/demo/).
//
//   npm run data:build            (after npm run data:fetch)
//
// Everything here is derived from NASA's own records and experimental tables, plus the curated
// lists already in this repo (public/data/*.json and the fire-safety pillars from the backend).
// No AI is used: summaries are NASA's sentences, scores are formulas written out in the "reason" fields.
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeness, makeModel } from '../nasaModel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'nasa-data'), OUT = join(ROOT, 'public', 'demo');
const { records, fetched } = JSON.parse(await readFile(join(RAW, 'records.json'), 'utf8'));

/* ------------------------------------------------------------------ helpers */
function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { return new TextDecoder('windows-1252').decode(buf).replace(/^ï»¿/, ''); }
}
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const sentences = (s) => clean(s).split(/(?<=[.!?])\s+(?=[A-Z(])/).filter((x) => x.length > 25);
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const year = (d) => { const m = String(d || '').match(/(\d{4})/); return m ? +m[1] : null; };
const NUM = /(?<![A-Za-z\d.])\d*\.?\d+(?:e[-+]?\d+)?(?![A-Za-z]*\d)/gi;
const nums = (cell) => (String(cell || '').replace(/,(?=\d{3}\b)/g, '').match(NUM) || []).map(Number).filter(Number.isFinite);
const psiUrl = (r) => (r.doi ? `https://doi.org/${r.doi}` : 'https://psi.nasa.gov/');

/* ------------------------------------------------------------------ curated lists (from the backend branch, app/habitats.py) */
const PILLAR_OF = {
  'PSI-10': ['detection', 'prevention'], 'PSI-20': ['prevention'], 'PSI-21': ['prevention', 'detection'], 'PSI-22': ['suppression', 'detection'],
  'PSI-23': ['prevention'], 'PSI-25': ['prevention'], 'PSI-26': ['prevention', 'suppression'], 'PSI-39': ['detection', 'prevention'],
  'PSI-47': ['detection'], 'PSI-60': ['detection'], 'PSI-62': ['prevention'], 'PSI-68': ['suppression', 'prevention'],
  'PSI-69': ['suppression', 'detection'], 'PSI-98': ['prevention'], 'PSI-99': ['prevention'], 'PSI-100': ['prevention', 'detection'],
  'PSI-101': ['detection'], 'PSI-102': ['detection'], 'PSI-106': ['prevention'], 'PSI-107': ['detection'], 'PSI-115': ['detection'],
  'PSI-117': ['prevention'], 'PSI-142': ['prevention'], 'PSI-159': ['prevention', 'detection'],
};
const LARGE_SCALE = new Set(['PSI-98', 'PSI-99', 'PSI-100']);     // Saffire: spacecraft-scale fires aboard Cygnus
const PARTIAL_G_PROXY = new Set(['PSI-22']);                        // ACME E-FIELD: electric-field body force mimics buoyancy

// Crew atmospheres. ISS: sea-level air. Gateway and Moon: NASA Exploration Atmospheres Working Group options
// (10.2 psi / 26.5 % O2 and 8.2 psi / 34 % O2). Mars: not defined by NASA yet, assumed equal to the Moon base.
const HABITATS = [
  { id: 'iss', name: 'International Space Station', body: 'Earth orbit', o2_pct: 21.0, pressure_kpa: 101.3, gravity_g: 0.0, status: 'baseline', lat: 0, lon: 0,
    description: 'Sea-level air (21 % O₂, 101.3 kPa) in microgravity, with forced ventilation.', source: 'ISS cabin specification; FLEX and ACME ran at these conditions' },
  { id: 'gateway', name: 'Lunar Gateway', body: 'Lunar orbit', o2_pct: 26.5, pressure_kpa: 70.3, gravity_g: 0.0, status: 'assumption', lat: 0, lon: 0,
    description: 'Intermediate exploration atmosphere (10.2 psi, 26.5 % O₂) in microgravity.', source: 'NASA Exploration Atmospheres Working Group', note: 'Gateway’s final setpoint is not confirmed; this is the NASA exploration option.' },
  { id: 'moon_base', name: 'Moon surface base', body: 'Moon', o2_pct: 34.0, pressure_kpa: 56.5, gravity_g: 0.165, status: 'assumption', lat: 0.7, lon: 23.4,
    description: 'Exploration atmosphere (8.2 psi, 34 % O₂) that shortens spacesuit pre-breathe, in lunar gravity.', source: 'NASA Exploration Atmospheres Working Group; challenge brief (≥30 % O₂ at ≤10.2 psi)', note: 'NASA has not fixed this atmosphere; it is the working assumption.' },
  { id: 'mars_base', name: 'Mars surface base', body: 'Mars', o2_pct: 34.0, pressure_kpa: 56.5, gravity_g: 0.378, status: 'assumption', lat: 18.4, lon: 77.5,
    description: 'Assumed to use the same atmosphere as the Moon base, in Mars gravity.', source: 'Assumption (no NASA Mars habitat atmosphere yet)', note: 'Assumed equal to the Moon base.' },
].map((h) => ({ ...h, o2_partial_kpa: r2((h.o2_pct / 100) * h.pressure_kpa) }));

/* ------------------------------------------------------------------ what kind of combustion each study is */
function kindOf(r) {
  const t = `${r.investigationAcronym} ${r.title} ${r.subResearchArea}`;
  if (/FLEX|CFI\b|Cool Flames Investigation$|droplet/i.test(t) && !/CFI-G|Gaseous/i.test(t)) return 'liquid droplet';
  if (/SAFFIRE|BASS|Surface|solid|Flame Spread/i.test(t)) return 'solid material';
  if (/SAME|DAFT|Smoke Aerosol|aerosol|dust/i.test(t)) return 'smoke / aerosol';
  return 'gas flame';
}
const platformOf = (r) => clean(r.flightProgram) || 'Not Applicable';
const gravityOf = (r) => (/ISS|Space Station|Cygnus/i.test(platformOf(r)) ? 'µg' : null);

/* ------------------------------------------------------------------ test rows from NASA's experimental tables */
const COL = {
  fuel: /^(fuel|fuel type|fuel sample material|sample material|material|sample \(fuel type\)|sample type|fuel bottle)$/i,
  o2: /\bx ?o2\b|o2 ?%|percent o2|oxygen|^o initial|calibrated\s+initial o2|^atmosphere/i,
  o2not: /final|after|mg\/s|sccm|\brate\b|mass|mfc|co2|\bco\b/i,
  p: /pressure|^p ?\(|^p(init|mean)|approx p/i,
  flow: /air flow|air rate|flow velocity|inlet velocity/i,
  outcome: /hot ignition|flames ignited|test end|self.?ext|cool flame\?|^result|extinction mode|comments/i,
  measure: /burning rate|burn rate|extinction diameter|spread rate|spread length|burn length|weight loss|rt\/r0|burn time|tad \(k\)|droplet initial diameter|initial droplet diameter|nozzle|burner size|thickness/i,
  dil: /^(co|co2|he|n)\s+initial ambient|^(helium)$|initial co2/i,
};
const pick = (cols, rx, not, prefer) => {
  const idx = cols.map((c, j) => [c, j]).filter(([c]) => rx.test(c) && !(not && not.test(c)));
  return (prefer && idx.find(([c]) => prefer.test(c)) || idx[0] || [null, -1])[1];
};
function pFactor(name, cell, v) {
  const s = `${name} ${cell}`.toLowerCase();
  if (/mm ?hg/.test(s)) return 0.133322; if (/\bbar\b/.test(s)) return 100; if (/atm/.test(s)) return 101.325; if (/psi/.test(s)) return 6.89476; if (/kpa/.test(s)) return 1;
  return v <= 5 ? 101.325 : 1;
}
const span = (v) => (v.length ? [r2(Math.min(...v)), r2(Math.max(...v))] : [null, null]);

function extractTable(r, table) {
  const rows = parseCsv(decode(table.buf)); if (rows.length < 2) return [];
  const cols = rows[0].map((c) => clean(c));
  const fuelHdr = cols.join(' ').match(/\bX ?(C2H4|CH4|C2H6|C3H8|H2)\b/);
  const j = {
    fuel: cols.findIndex((c) => COL.fuel.test(c)), o2: pick(cols, COL.o2, COL.o2not, /init|before/i),
    p: pick(cols, COL.p, /final/i, /pmean|approx p|ambient/i), flow: pick(cols, COL.flow, /mg\/s|sccm/i),
  };
  const outc = cols.map((c, k) => [c, k]).filter(([c]) => COL.outcome.test(c));
  const meas = cols.map((c, k) => [c, k]).filter(([c]) => COL.measure.test(c));
  const dils = cols.map((c, k) => [c, k]).filter(([c]) => COL.dil.test(c));
  const kind = kindOf(r), g = gravityOf(r);
  return rows.slice(1).map((row, i) => {
    const cell = (k) => clean(k >= 0 ? row[k] : '');
    let o2 = nums(cell(j.o2)).map((x) => (x <= 1 ? x * 100 : x)).filter((x) => x > 0 && x <= 100);
    if (!o2.length && /air\b|21 ?%/i.test(cell(j.o2))) o2 = [21];
    const praw = nums(cell(j.p)).filter((x) => x > 0), pf = praw.length ? pFactor(cols[j.p], cell(j.p), praw[0]) : 1;
    const flow = nums(cell(j.flow)).filter((x) => x >= 0 && x < 1000);
    const dil = Object.fromEntries(dils.map(([c, k]) => [/^he|helium/i.test(c) ? 'He' : /^n\s/i.test(c) ? 'N2' : 'CO2', nums(cell(k))[0]]).filter(([, v]) => v > 0).map(([n, v]) => [n, r2(v <= 1 ? v * 100 : v)]));
    const fuel = (cell(j.fuel) || (fuelHdr ? fuelHdr[1] : '')).slice(0, 120);
    const outcome = outc.map(([c, k]) => (cell(k) && cell(k) !== '-' ? `${c}: ${cell(k)}` : '')).filter(Boolean).join('; ').slice(0, 220);
    const measures = meas.map(([c, k]) => (cell(k) && !/^n\/a$/i.test(cell(k)) ? `${c} ${cell(k)}` : '')).filter(Boolean).join('; ').slice(0, 200);
    if (!fuel && !o2.length && !praw.length && !outcome) return null;
    if (/^pre-test flow/i.test(fuel)) return null;   // SAFFIRE tables list flow-visualisation runs, not burns
    const [omin, omax] = span(o2), [pmin, pmax] = span(praw.map((x) => x * pf));
    const evidence = `${table.name}, row ${i + 1}: ` + cols.map((c, k) => (clean(row[k]) ? `${c} = ${clean(row[k])}` : '')).filter(Boolean).join(' · ');
    return {
      investigation_id: r.accession, fuel: fuel || '—', fuel_type: kind, oxygen_pct_min: omin, oxygen_pct_max: omax, pressure_kpa_min: pmin, pressure_kpa_max: pmax,
      flow_velocity_cm_s: flow.length ? r2(flow[0]) : null, gravity_g: g, diluents: Object.keys(dil).length ? dil : undefined,
      key_result: [outcome, measures].filter(Boolean).join(' · ') || '—', evidence: evidence.slice(0, 900),
    };
  }).filter(Boolean);
}

/* ------------------------------------------------------------------ FLEX droplet tests: the data behind the flame model */
function flexTests(r, table, rowsOut) {
  const rows = parseCsv(decode(table.buf)), cols = rows[0].map(clean), c = (name) => cols.findIndex((x) => x.startsWith(name));
  const k = { id: c('FLEX Identifier'), n: c('FLEX Test #'), fuel: c('Fuel'), p: c('Ambient pressure'), o2: c('O initial'), co2: c('CO initial'), he: c('He initial'), d0: c('Droplet initial'), de: c('Visible flame extinction'), rate: c('Burning rate'), bt: c('Burn time'), end: c('Test end') };
  const f = (row, j) => { const v = parseFloat(row[j]); return Number.isFinite(v) ? v : null; };
  return rows.slice(1).map((row, i) => {
    const d0 = f(row, k.d0), de = f(row, k.de), end = clean(row[k.end]);
    const p = f(row, k.p), o2 = f(row, k.o2);
    if (!(p > 0) || !(o2 > 0)) return null;   // one FLEX row lists 0 mmHg: unusable for the model
    const endKind = /^complet/i.test(end) ? 'Completion' : /^disrupt/i.test(end) ? 'Disruption' : /^extinc/i.test(end) ? 'Extinction' : end;
    const ratio = endKind === 'Completion' ? 0 : d0 && de != null && endKind === 'Extinction' ? Math.min(1, de / d0) : null;
    return {
      test_id: `FLEX-${clean(row[k.id]) || clean(row[k.n])}`, investigation_id: r.accession, fuel: clean(row[k.fuel]),
      o2_pct: r2(o2 * 100), pressure_kpa: r2(p * 0.133322), co2_pct: r2((f(row, k.co2) || 0) * 100), he_pct: r2((f(row, k.he) || 0) * 100),
      d0_mm: d0, dext_mm: de, dext_ratio: ratio == null ? null : r2(ratio), fuel_burned: ratio == null ? null : Math.round((1 - ratio ** 3) * 1000) / 1000,
      k_mm2_s: f(row, k.rate), burn_time_s: f(row, k.bt), end: endKind, chunk_id: `${r.accession}::row::${rowsOut[i]}`,
    };
  }).filter(Boolean);
}

/* ------------------------------------------------------------------ build */
const passages = [];                 // searchable text: NASA record fields, table summaries, curated repo data
const addPassage = (id, acc, file, text, extra = {}) => { if (clean(text)) passages.push({ id, investigation_id: acc, file, text: clean(text), ...extra }); };
function chunked(acc, field, label, text) {
  const ids = [], ss = sentences(text); let buf = '', n = 0;
  const flush = () => { if (buf) { const id = `${acc}::${field}::${n}`; addPassage(id, acc, `${acc} · ${label}`, buf); ids.push(id); n += 1; buf = ''; } };
  for (const s of ss.length ? ss : [clean(text)]) { if ((buf + ' ' + s).length > 700) flush(); buf = buf ? `${buf} ${s}` : s; }
  flush();
  return ids;
}

const investigations = [], details = {}, allTests = [], facts = [], materials = [];
for (const r of records) {
  const acc = r.accession, acronym = clean(r.investigationAcronym) || acc, kind = kindOf(r), pillars = PILLAR_OF[acc] || [];
  const sources = [];
  for (const [field, label] of [['objective', 'Objective'], ['approach', 'Approach'], ['hypothesis', 'Hypothesis'], ['researchImpacts', 'Research impacts / Earth benefits'], ['description', 'Description']]) {
    chunked(acc, field, label, r[field]).forEach((id, i) => sources.push({ chunk_id: id, file: `${acc} · ${label}`, page: 0, i }));
  }
  if (r.publications.length) addPassage(`${acc}::publications::0`, acc, `${acc} · Publications`, `${acronym} publications listed by NASA PSI: ` + r.publications.slice(0, 25).map((p) => `“${clean(p.title)}” (${clean(p.authors).split(',').slice(0, 3).join(',')}${p.doi ? `, doi ${p.doi}` : ''})`).join('; '));
  const pis = r.contacts.filter((c) => /principal/i.test(c.role));
  if (r.contacts.length) addPassage(`${acc}::team::0`, acc, `${acc} · Team`, `${acronym} (${r.title}) team: ` + r.contacts.map((c) => `${c.name} (${c.role}${c.affiliation ? `, ${c.affiliation}` : ''})`).join('; ') + `. Hardware: ${clean(r.experimentHardware) || 'not listed'}. Managing NASA center: ${clean(r.managingNasaCenter) || 'not listed'}.`);

  // experimental tables
  const experiments = [];
  for (const t of r.tables) {
    const buf = await readFile(join(RAW, 'tables', t.file));
    const rows = extractTable(r, { ...t, buf });
    const start = experiments.length;
    experiments.push(...rows);
    if (/FLEX\.csv$/i.test(t.name)) {
      const rowIndex = rows.map((_, i) => start + i);
      allTests.push(...flexTests(r, { ...t, buf }, rowIndex));
    }
  }
  experiments.forEach((e, i) => { e.chunk_id = `${acc}::row::${i}`; });

  const o2 = experiments.flatMap((e) => [e.oxygen_pct_min, e.oxygen_pct_max]).filter((v) => v != null);
  const pr = experiments.flatMap((e) => [e.pressure_kpa_min, e.pressure_kpa_max]).filter((v) => v != null);
  const fuels = [...new Set(experiments.map((e) => e.fuel).filter((f) => f && f !== '—'))];
  const dil = {}; experiments.forEach((e) => Object.keys(e.diluents || {}).forEach((d) => { if (d !== 'N2') (dil[e.fuel] ||= new Set()).add(d); }));
  const y0 = year(r.investigationStartDate), y1 = year(r.investigationEndDate) || y0;
  if (experiments.length) {
    const txt = `${acronym} (${acc}) NASA experimental table summary: ${experiments.length} test rows` +
      (fuels.length ? `; ${kind === 'solid material' ? 'materials' : 'fuels'} tested: ${fuels.slice(0, 14).join(', ')}${fuels.length > 14 ? ` and ${fuels.length - 14} more` : ''}` : '') +
      (o2.length ? `; oxygen from ${Math.min(...o2)} % to ${Math.max(...o2)} %` : '; oxygen not listed in the table') +
      (pr.length ? `; pressure from ${Math.min(...pr)} kPa to ${Math.max(...pr)} kPa` : '; pressure not listed in the table') +
      (Object.keys(dil).length ? `; diluents: ${Object.entries(dil).map(([f, s]) => `${f} with ${[...s].join(' and ')}`).join(', ')}` : '') +
      `. Platform: ${platformOf(r)}${y0 ? `, ${y0}–${y1}` : ''}.`;
    addPassage(`${acc}::tables::0`, acc, `${acc} · Experimental table summary`, txt);
    sources.push({ chunk_id: `${acc}::tables::0`, file: `${acc} · Experimental table summary`, page: 0 });
  }
  // every table row can be opened as a passage (served from the investigation file, see demo.js)

  // knowledge-graph style facts (used by the researcher's "Graph" toggle)
  const F = (s) => facts.push({ investigation_id: acc, acronym, text: s });
  F(`${acronym} (${acc}) — studied → ${kind}; platform → ${platformOf(r)}${y0 ? `; years → ${y0}–${y1}` : ''}`);
  if (pillars.length) F(`${acronym} — supports fire-safety pillar → ${pillars.join(', ')}`);
  fuels.slice(0, 20).forEach((f) => F(`${acronym} — tested ${kind === 'solid material' ? 'material' : 'fuel'} → ${f}${dil[f] ? ` (with ${[...dil[f]].join(' and ')})` : ''}`));
  if (o2.length) F(`${acronym} — oxygen range → ${Math.min(...o2)}–${Math.max(...o2)} %`);
  if (pr.length) F(`${acronym} — pressure range → ${Math.min(...pr)}–${Math.max(...pr)} kPa`);
  if (PARTIAL_G_PROXY.has(acc)) F(`${acronym} — partial-gravity proxy → electric field creates a buoyancy-like body force`);
  if (LARGE_SCALE.has(acc)) F(`${acronym} — scale → spacecraft-scale fire aboard an uncrewed Cygnus vehicle`);
  pis.forEach((c) => F(`${acronym} — principal investigator → ${c.name}${c.affiliation ? ` (${c.affiliation})` : ''}`));
  if (kind === 'solid material' || kind === 'smoke / aerosol') fuels.forEach((m) => materials.push({ material: m, investigation_id: acc, acronym, kind, chunk_id: experiments.find((e) => e.fuel === m)?.chunk_id }));

  const obj = sentences(r.objective), imp = sentences(r.researchImpacts), app = sentences(r.approach);
  const tags = [...new Set([clean(r.subResearchArea), kind, ...pillars])].filter(Boolean);
  const safety = pillars.length
    ? `Supports NASA’s ${pillars.join(' and ')} pillar${pillars.length > 1 ? 's' : ''} of spacecraft fire safety.` + (LARGE_SCALE.has(acc) ? ' One of the few spacecraft-scale fire tests ever run.' : '') + (PARTIAL_G_PROXY.has(acc) ? ' Its electric field mimics buoyancy, the closest thing in this archive to partial-gravity flame data.' : '')
    : null;
  const inv = {
    id: acc, acronym, name: clean(r.title), platform: platformOf(r), years: y0 ? [y0, y1] : null, url: psiUrl(r), doi: r.doi || null, license: r.licenseIdentifier || null,
    one_sentence_pitch: (obj[0] || app[0] || clean(r.title)).slice(0, 260), plain_summary: obj.slice(0, 3).join(' ') || app.slice(0, 2).join(' '),
    objectives: obj.slice(0, 4), method: app.slice(0, 3).join(' '), main_findings: imp.slice(0, 4), safety_relevance: safety, tags,
    fire_pillars: pillars, kind, hardware: clean(r.experimentHardware) || null, center: clean(r.managingNasaCenter) || null,
    principal_investigators: pis.map((c) => c.name), n_publications: r.publications.length, n_files: r.n_files, sources: sources.slice(0, 8),
  };
  investigations.push(inv);
  details[acc] = { ...inv, experiments, n_experiments: experiments.length, publications: r.publications.slice(0, 30) };
}

/* ------------------------------------------------------------------ ranking criteria per habitat (weights are applied in the browser) */
/** Distinct tested atmospheres of a study: [[o2_min, o2_max, p_min, p_max], ...] (closeness is recomputed in the browser for what-ifs). */
function rangesOf(d) {
  const seen = new Map();
  d.experiments.filter((e) => e.oxygen_pct_min != null).forEach((e) => { const r = [e.oxygen_pct_min, e.oxygen_pct_max, e.pressure_kpa_min, e.pressure_kpa_max]; seen.set(r.join(), r); });
  return [...seen.values()];
}
function criteria(inv, h) {
  const d = details[inv.id], p = inv.fire_pillars, big = LARGE_SCALE.has(inv.id);
  const pil = (k, txt) => (p.includes(k) ? { score: 0.9, reason: `NASA fire-safety pillar “${k}”: ${txt}` } : { score: 0.2, reason: `Not one of this study’s fire-safety pillars (${p.join(', ') || 'none listed'}).` });
  const flam = p.includes('prevention') ? { score: big ? 1 : 0.9, reason: `Prevention pillar: ignition, spread or flammability limits${big ? ', at spacecraft scale' : ''}.` } : pil('prevention');
  const orbital = /ISS|Space Station|Cygnus/i.test(inv.platform), partial = h.gravity_g > 0;
  let phys, why;
  if (partial && PARTIAL_G_PROXY.has(inv.id)) { phys = 1; why = `Electric-field flames mimic buoyancy: the closest proxy to ${h.gravity_g} g in this archive.`; }
  else if (orbital) { phys = partial ? 0.6 : 1; why = partial ? `Microgravity data (${inv.platform}) bounds the no-buoyancy limit; ${h.body} has ${h.gravity_g} g, which is not tested directly.` : `Flown in microgravity (${inv.platform}), like ${h.name}.`; }
  else { phys = 0.4; why = 'Analysis or modelling study, not a new flight test.'; }
  if (big) { phys = Math.min(1, phys + 0.1); why += ' Large-scale fire.'; }
  const close = closeness(rangesOf(d), h.o2_pct, h.pressure_kpa);
  return {
    flammability: flam,
    detection: pil('detection', 'smoke, soot or flame signatures relevant to detecting a fire early.'),
    suppression: pil('suppression', 'extinction, dilution or suppressant behaviour.'),
    physics: { score: r2(phys), reason: why },
    closeness: close,
  };
}

const intervalGap = (v, lo, hi) => (v < lo ? lo - v : v > hi ? v - hi : 0);

/* ------------------------------------------------------------------ write */
await rm(OUT, { recursive: true, force: true });
const save = async (rel, data) => { const f = join(OUT, rel); await mkdir(dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(data)); };

await save('meta.json', { source: 'NASA Physical Sciences Informatics (psi.nasa.gov)', fetched, built: new Date().toISOString().slice(0, 10), investigations: investigations.length, test_rows: Object.values(details).reduce((s, d) => s + d.n_experiments, 0), flex_tests: allTests.length, model_validation: makeModel(allTests).validate() });
await save('habitats.json', HABITATS);
await save('investigations.json', investigations);
for (const [id, d] of Object.entries(details)) await save(`investigation/${id}.json`, d);
for (const h of HABITATS) {
  await save(`rank/${h.id}.json`, { habitat: h, results: investigations.map((inv) => ({ id: inv.id, acronym: inv.acronym, name: inv.name, platform: inv.platform, url: inv.url, ranges: rangesOf(details[inv.id]), criteria: criteria(inv, h) })) });
}
await save('tests.json', allTests);
await save('fuels.json', [...new Set(allTests.map((t) => t.fuel))].sort());

// curated repo data becomes searchable too
for (const name of ['findings', 'history', 'gravity', 'earth-impact', 'luci', 'acme']) {
  let data; try { data = JSON.parse(await readFile(join(ROOT, 'public', 'data', `${name}.json`), 'utf8')); } catch { continue; }
  const items = Array.isArray(data) ? data : Object.values(data).flat();
  items.filter((x) => x && typeof x === 'object').forEach((x, i) => addPassage(`repo::${name}::${i}`, null, `FlameX curated data · ${name}`, Object.entries(x).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join('; ')));
}
// habitat coverage notes ("which tests cover lunar base conditions?")
for (const h of HABITATS) {
  const near = [];
  for (const d of Object.values(details)) {
    const rows = d.experiments.filter((e) => e.oxygen_pct_min != null && intervalGap(h.o2_pct, e.oxygen_pct_min, e.oxygen_pct_max) <= 3 && (e.pressure_kpa_min == null || intervalGap(h.pressure_kpa, e.pressure_kpa_min * 0.8, e.pressure_kpa_max * 1.25) === 0));
    if (rows.length) near.push(`${d.acronym} (${d.id}): ${rows.length} test rows within 3 % O₂${rows.some((e) => e.pressure_kpa_min == null) ? ' (some without pressure)' : ''} of these conditions`);
  }
  const body = h.body === 'Moon' ? 'Moon, lunar base, lunar surface' : h.body === 'Mars' ? 'Mars, Martian base' : h.body;
  addPassage(`habitat::${h.id}`, null, `FlameX analysis of NASA test tables · ${h.name}`,
    `Tests covering ${h.name} conditions (${body}; ${h.o2_pct} % O₂ at ${h.pressure_kpa} kPa, ${h.gravity_g} g): ` + (near.length ? near.join('; ') : 'no NASA test row is within 3 % O₂ and a factor 1.25 in pressure') +
    `. All of these tests ran in microgravity or on the ground; none ran at ${h.gravity_g ? `${h.gravity_g} g` : 'a habitat atmosphere other than the listed one'}.`);
}
// Partial gravity: what the archive does and does not contain (from the habitat list and the backend's curated flags)
addPassage('analysis::partial-gravity', null, 'FlameX analysis of NASA PSI records · partial gravity',
  `Partial-gravity combustion data (Moon 0.165 g, Mars 0.38 g): none of the 24 NASA PSI combustion investigations ran a fire test at partial gravity. ` +
  `They ran in microgravity aboard the ISS or Cygnus, in drop towers, or are analysis studies. The closest proxy is ACME E-FIELD Flames (PSI-22), where an electric field ` +
  `creates a buoyancy-like body force on the flame. Partial gravity is therefore the largest data gap for Moon and Mars bases.`);
// Plain physics for the student questions (textbook combustion, labelled as such, not a NASA record)
const EXPLAIN = [
  ['space-vs-earth', 'The difference between a flame in space and a flame on Earth (textbook combustion physics). On Earth, gravity makes the hot gas of a flame rise because it is lighter than the air around it: this buoyancy stretches the flame into a teardrop and keeps pulling fresh oxygen in from below, so the flame is tall, bright yellow and sooty. In space (microgravity) there is no buoyancy, so hot gas does not rise and no draft feeds the flame. Oxygen only reaches it by slow diffusion from all sides, so the flame becomes a sphere, smaller, cooler, dimmer and often blue. Flames in space can also keep burning at lower temperatures (cool flames, seen in FLEX) and spread differently over materials, which is why NASA tests fire safety in orbit instead of relying on Earth tests.'],
  ['microgravity', 'What microgravity means for fire (textbook physics): in orbit everything falls together, so there is almost no weight and no buoyancy (about one millionth of Earth gravity on the ISS). Smoke does not rise to a ceiling detector, fresh air only reaches a fire through ventilation fans or diffusion, and a fire can smoulder unseen. NASA reproduces microgravity in drop towers (a few seconds), aircraft parabolas (about 25 seconds) and on the ISS (as long as needed).'],
  ['oxygen-role', 'Why oxygen level matters for fire in a habitat (textbook combustion physics): a fire needs fuel, heat and oxygen. More oxygen in the cabin air makes materials ignite more easily, burn faster and stay lit at sizes where they would otherwise go out. Planned Moon habitats may use 34 % oxygen at lower pressure (instead of 21 % on Earth), so materials that are safe on Earth may burn there; NASA tests such as FLEX measured this up to 34 % oxygen.'],
  ['round-flame', 'Why a flame is round in space (textbook combustion physics): on Earth, hot gas from a flame is lighter than the air around it, so buoyancy lifts it and pulls in fresh air from below; that gives a candle its teardrop shape. In microgravity there is no buoyancy, so hot gas does not rise. Oxygen reaches the flame only by slow diffusion from every side, so the flame becomes a sphere, burns cooler and dimmer, and often looks blue because less soot forms. NASA droplet experiments such as FLEX and CFI study these spherical flames.'],
  ['crew-safety', 'How astronauts stay safe from fire (NASA fire-safety pillars): prevention, by choosing materials that pass NASA-STD-6001 flammability tests and limiting oxygen; detection, with smoke detectors tuned to the smaller smoke particles seen in microgravity (studied by SAME, SAME-R and DAFT); and suppression, with portable extinguishers, shutting off ventilation and crew procedures (studied by FLEX, FLEX-2 and BASS).'],
  ['earth-benefits', 'How space combustion research helps firefighters and people on Earth (NASA research impacts). Microgravity removes buoyancy, so researchers can see the basic chemistry of flames, soot and extinction. This improves fire-spread and smoke-detector models used for buildings, makes engines and burners cleaner and more efficient, and helps choose safer materials. See the research-impact statements of each NASA PSI record.'],
];
EXPLAIN.forEach(([k, t]) => {
  const m = t.match(/^(.*?) \(([^)]*)\)[.:]\s*(.*)$/s);
  addPassage(`explainer::${k}`, null, `FlameX explainer · ${m ? m[1] : k} (${m ? m[2] : 'textbook physics'})`, m ? m[3].charAt(0).toUpperCase() + m[3].slice(1) : t);
});
await save('passages.json', passages);
await save('facts.json', facts);
await save('materials-ref.json', materials);
await copyFile(join(ROOT, 'samples', 'materials_test.csv'), join(OUT, 'materials_test.csv'));

console.log(`Built public/demo/: ${investigations.length} investigations, ${Object.values(details).reduce((s, d) => s + d.n_experiments, 0)} test rows, ${allTests.length} FLEX droplet tests, ${passages.length} passages, ${facts.length} facts, ${materials.length} NASA materials.`);
