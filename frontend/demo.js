// Public-site API: the same functions as the live `api` in api.js, answered in the browser from NASA's own data.
// The JSON in public/demo/ is built from NASA PSI downloads by scripts/build-nasa-data.mjs (npm run data:fetch, data:build).
//
//   investigations, details, compare   NASA PSI records and their experimental tables (1,986 test rows)
//   predict, flammap, what-if, gaps    kernel model fitted on the 273 FLEX droplet tests (nasaModel.js)
//   rank                               AHP-style weighted score; criteria from NASA fire-safety pillars and tested atmospheres
//   ask                                keyword search (BM25) over NASA's text; the answer quotes the best sentences, no AI
//   materials                          rule-based screening: LOI vs cabin O₂, NASA-STD-6001 Test 1, match to NASA-tested materials
import { closeness, CRITERIA, DEFAULT_PRIORITIES, makeModel } from './nasaModel.js';

const ROOT = `${import.meta.env.BASE_URL}demo/`;
const cache = new Map();
function D(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(ROOT + path).then((r) => {
      if (!r.ok) throw new Error(`NASA data file ${path} is missing from this site.`);
      return r.json();
    }).catch((e) => { cache.delete(path); throw e; }));
  }
  return cache.get(path);
}
const r3 = (x) => Math.round(x * 1000) / 1000;
const habitat = async (id) => { const h = (await D('habitats.json')).find((x) => x.id === id); if (!h) throw new Error(`Unknown habitat ${id}.`); return h; };
let modelP = null;
const model = () => (modelP ||= D('tests.json').then(makeModel));

/* ---------------------------------------------------------------- ranking */
function rerank(rec, body = {}) {
  const p = body.priorities || DEFAULT_PRIORITIES;
  const raw = CRITERIA.map((k) => Math.max(0.0001, +p[k] || 1)), sum = raw.reduce((a, b) => a + b, 0);
  const w = Object.fromEntries(CRITERIA.map((k, i) => [k, raw[i] / sum]));
  const results = rec.results.map(({ ranges, ...r }) => {
    const criteria = Object.fromEntries(CRITERIA.map((k) => {
      const c = r.criteria[k] || { score: 0 };
      return [k, { ...c, weight: r3(w[k]), owa_weight: r3(w[k]), contribution: r3(c.score * w[k]) }];
    }));
    return { ...r, criteria, score: r3(CRITERIA.reduce((s, k) => s + criteria[k].score * w[k], 0)) };
  }).sort((a, b) => b.score - a.score).map((r, i) => ({ ...r, rank: i + 1 }));
  return {
    ...rec, ahp: { weights: w, lambda_max: 5, ci: 0, cr: 0, consistent: true },
    method: 'Weighted sum of five criteria (weights proportional to your priorities). Criteria come from NASA’s fire-safety pillars, the test platform, and how close NASA’s tested atmospheres are to the habitat.',
    results: body.top ? results.slice(0, body.top) : results,
  };
}
/** The same ranking for another atmosphere: only "closeness" depends on O₂ and pressure. */
const withAtmosphere = (rec, o2, p) => ({ ...rec, results: rec.results.map((r) => ({ ...r, criteria: { ...r.criteria, closeness: closeness(r.ranges, o2, p) } })) });

/* ---------------------------------------------------------------- flame model */
async function predict(b) {
  const m = await model();
  let o2 = +b.o2_pct, p = +b.pressure_kpa;
  if (b.habitat_id && !(o2 && p)) { const h = await habitat(b.habitat_id); o2 = h.o2_pct; p = h.pressure_kpa; }
  const q = { o2_pct: o2, pressure_kpa: p, co2_pct: +b.co2_pct || 0, he_pct: +b.he_pct || 0, d0_mm: +b.d0_mm || null };
  const r = m.predict(b.fuel, q), info = m.info[b.fuel], warnings = [];
  const inBox = o2 >= info.o2_pct[0] && o2 <= info.o2_pct[1] && p >= info.pressure_kpa[0] && p <= info.pressure_kpa[1];
  if (!inBox) warnings.push(`${o2} % O₂ at ${p} kPa is outside NASA’s ${b.fuel} tests (${info.o2_pct[0]}–${info.o2_pct[1]} % O₂, ${Math.round(info.pressure_kpa[0])}–${Math.round(info.pressure_kpa[1])} kPa): extrapolation, read the range, not the number.`);
  else if (r.distance > 2) warnings.push(`No NASA ${b.fuel} test is close to this exact mix (nearest is ${r.distance} model units away); the range is wide for that reason.`);
  if (q.co2_pct > info.co2_max) warnings.push(`NASA tested ${b.fuel} with at most ${info.co2_max} % CO₂.`);
  if (q.he_pct > info.he_max) warnings.push(`NASA tested ${b.fuel} with at most ${info.he_max} % helium.`);
  const nearest = m.nearest(b.fuel, q).map(({ t, d }) => ({
    test_id: t.test_id, investigation_id: t.investigation_id, o2_pct: t.o2_pct, pressure_kpa: t.pressure_kpa, co2_pct: t.co2_pct, he_pct: t.he_pct,
    d0_mm: t.d0_mm, dext_ratio: t.dext_ratio, k_mm2_s: t.k_mm2_s, end: t.end, distance: r3(d), chunk_id: t.chunk_id, url: 'https://doi.org/10.60555/mbq8-0451',
  }));
  const dext = (fb) => r3(Math.cbrt(Math.max(0, 1 - fb)));
  return {
    inputs: { fuel: b.fuel, ...q, d0_mm: r.d0_mm, o2_partial_kpa: r3((o2 / 100) * p) },
    fuel_burned: r.fuel_burned,
    dext_ratio: { mean: dext(r.fuel_burned.mean), low: dext(r.fuel_burned.high), high: dext(r.fuel_burned.low) },
    burning_rate_mm2_s: r.burning_rate_mm2_s,
    in_range: inBox && r.distance <= 2, distance_to_nearest_test: r.distance, warnings, nearest_tests: nearest,
    gravity_note: 'Fitted on NASA FLEX droplet tests aboard the ISS (microgravity). Gravity is not an input: results are for microgravity, a worst case for a spherical, buoyancy-free flame.',
  };
}

const mapCache = new Map();
async function flammap(hid, fuel, n = 40) {
  const key = `${hid}|${fuel}|${n}`;
  if (mapCache.has(key)) return mapCache.get(key);
  const [m, h, habitats] = await Promise.all([model(), habitat(hid), D('habitats.json')]);
  if (!m.byFuel[fuel]) throw new Error(`No NASA tests for ${fuel}.`);
  const O = Array.from({ length: n }, (_, i) => r3(10 + (i * 35) / (n - 1)));
  const P = Array.from({ length: n }, (_, i) => r3(30 * (320 / 30) ** (i / (n - 1))));
  const g = { fuel_burned: [], fuel_burned_low: [], fuel_burned_high: [], uncertainty: [], burning_rate_mm2_s: [], distance_to_tests: [], no_data: [] };
  for (const p of P) {
    const row = Object.fromEntries(Object.keys(g).map((k) => [k, []]));
    for (const o of O) {
      const r = m.predict(fuel, { o2_pct: o, pressure_kpa: p });
      row.fuel_burned.push(r.fuel_burned.mean); row.fuel_burned_low.push(r.fuel_burned.low); row.fuel_burned_high.push(r.fuel_burned.high);
      row.uncertainty.push(r3(r.fuel_burned.high - r.fuel_burned.low)); row.burning_rate_mm2_s.push(r.burning_rate_mm2_s.mean);
      row.distance_to_tests.push(r.distance); row.no_data.push(r.distance > 3);
    }
    Object.keys(g).forEach((k) => g[k].push(row[k]));
  }
  const info = m.info[fuel];
  const summary = await Promise.all(m.fuels.map(async (f) => ({ fuel: f, id: h.id, fuel_burned: (await predict({ fuel: f, o2_pct: h.o2_pct, pressure_kpa: h.pressure_kpa })).fuel_burned })));
  const out = {
    habitat: h, summary,
    map: {
      fuel, axes: { o2_pct: O, pressure_kpa: P, pressure_scale: 'log' }, ...g,
      tested_range: { o2_pct: info.o2_pct, pressure_kpa: info.pressure_kpa.map(Math.round), n_tests: info.n },
      tests: m.byFuel[fuel].map((t) => ({ test_id: t.test_id, investigation_id: t.investigation_id, o2_pct: t.o2_pct, pressure_kpa: t.pressure_kpa, co2_pct: t.co2_pct, he_pct: t.he_pct, diluent: t.co2_pct > 0 || t.he_pct > 0, dext_ratio: t.dext_ratio, chunk_id: t.chunk_id })),
      habitats: habitats.map((x) => ({ id: x.id, name: x.name, o2_pct: x.o2_pct, pressure_kpa: x.pressure_kpa })),
      notes: `Kernel model on ${info.n} NASA FLEX ${fuel} tests (${info.n_outcomes} with a measured extinction). Hatched: more than 3 model units from any test.`,
    },
  };
  mapCache.set(key, out);
  return out;
}

async function gaps(hid, n = 6, explain = false) {
  const [m, h] = await Promise.all([model(), habitat(hid)]);
  const cand = [];
  for (const fuel of m.fuels) {
    for (let o = h.o2_pct - 8; o <= h.o2_pct + 8.01; o += 1) {
      for (let k = -6; k <= 6; k += 1) {
        const p = h.pressure_kpa * 1.08 ** k, r = m.predict(fuel, { o2_pct: o, pressure_kpa: p });
        const unc = r.fuel_burned.high - r.fuel_burned.low, near = Math.exp(-0.5 * (((o - h.o2_pct) / 5) ** 2 + (Math.log(p / h.pressure_kpa) / 0.35) ** 2));
        cand.push({ fuel, o: r3(o), p: r3(p), r, unc, score: unc * near });
      }
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of cand) {
    if (picked.length >= n) break;
    if (picked.some((x) => x.fuel === c.fuel && Math.abs(x.o - c.o) < 3 && Math.abs(Math.log(x.p / c.p)) < 0.15)) continue;
    picked.push(c);
  }
  const suggestions = picked.map((c, i) => {
    const info = m.info[c.fuel], [{ t }] = m.nearest(c.fuel, { o2_pct: c.o, pressure_kpa: c.p }, 1), out = [];
    if (c.o < info.o2_pct[0] || c.o > info.o2_pct[1]) out.push('oxygen');
    if (c.p < info.pressure_kpa[0] || c.p > info.pressure_kpa[1]) out.push('pressure');
    return {
      rank: i + 1, fuel: c.fuel, o2_pct: r3(c.o), pressure_kpa: r3(c.p), co2_pct: 0, he_pct: 0, d0_mm: info.d0_median, uncertainty: r3(c.unc),
      predicted_fuel_burned: c.r.fuel_burned, nearest_test: { test_id: t.test_id, o2_pct: t.o2_pct, pressure_kpa: t.pressure_kpa, chunk_id: t.chunk_id },
      outside_tested_range: out, reason: `The model’s 90 % range spans ${Math.round(c.unc * 100)} points here and the point is close to ${h.name}’s air.`,
    };
  });
  const top = suggestions[0];
  return {
    suggestions,
    caveat: 'Ranked by model uncertainty × closeness to the habitat’s atmosphere. A wide range means NASA’s tests do not pin the outcome down there.',
    gravity_note: 'All FLEX tests ran in microgravity; partial gravity (Moon, Mars) is a gap no droplet test in this archive covers.',
    explanation: explain && top ? `The most informative next test is ${top.fuel} at ${top.o2_pct.toFixed(1)} % O₂ and ${top.pressure_kpa.toFixed(0)} kPa. The nearest NASA run (${top.nearest_test.test_id}, ${top.nearest_test.o2_pct} % O₂, ${top.nearest_test.pressure_kpa} kPa) is too far for the model to be confident, and its predicted burn of ${Math.round(top.predicted_fuel_burned.low * 100)}–${Math.round(top.predicted_fuel_burned.high * 100)} % is too wide to set a safety margin. ${top.outside_tested_range.length ? `It also lies outside the tested ${top.outside_tested_range.join(' and ')} range.` : 'It lies inside the tested box, between existing runs.'} This explanation is generated from the numbers above, not by an AI model.` : null,
  };
}

/* ---------------------------------------------------------------- what-if */
const HAB_WORDS = [[/\b(iss|space station)\b/i, 'iss'], [/\bgateway\b/i, 'gateway'], [/\b(moon|lunar)\b/i, 'moon_base'], [/\b(mars|martian)\b/i, 'mars_base']];
function parseScenario(text) {
  const t = ` ${text.toLowerCase().replace(',', '.')} `, out = {};
  const hab = HAB_WORDS.find(([rx]) => rx.test(t)); if (hab) out.habitat_id = hab[1];
  const gas = (names) => {
    const n = `(?:${names})`;
    const m = t.match(new RegExp(`${n}[^\\d%]{0,25}?(?:to|at|of|=|:)?\\s*(\\d+(?:\\.\\d+)?)\\s*%`)) || t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*%\\s*${n}`));
    return m ? +m[1] : undefined;
  };
  out.o2_pct = gas('oxygen|o2|o₂'); out.co2_pct = gas('carbon dioxide|co2|co₂'); out.he_pct = gas('helium|he\\b');
  const pm = t.match(/(\d+(?:\.\d+)?)\s*(kpa|psi|atm|bar|mmhg)\b/);
  if (pm) out.pressure_kpa = r3(+pm[1] * { kpa: 1, psi: 6.89476, atm: 101.325, bar: 100, mmhg: 0.133322 }[pm[2]]);
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

async function whatif(b) {
  let req = b, parsed = null;
  if (b.text) {
    const s = parseScenario(b.text);
    if (!['o2_pct', 'pressure_kpa', 'co2_pct', 'he_pct'].some((k) => k in s)) {
      return { status: 'not_understood', problem: 'no oxygen, pressure, CO₂ or helium value found. Try for example “Moon base at 30 % oxygen and 70 kPa” or “ISS with 5 % CO₂”.' };
    }
    req = { habitat_id: s.habitat_id || b.habitat_id || 'moon_base', ...s };
  }
  const hab = await habitat(req.habitat_id), [m, rec] = await Promise.all([model(), D(`rank/${hab.id}.json`)]);
  const after = { o2_pct: req.o2_pct ?? hab.o2_pct, pressure_kpa: req.pressure_kpa ?? hab.pressure_kpa, co2_pct: req.co2_pct ?? 0, he_pct: req.he_pct ?? 0 };
  const errors = [];
  if (after.o2_pct + after.co2_pct + after.he_pct > 100) errors.push(`O₂ + CO₂ + He = ${after.o2_pct + after.co2_pct + after.he_pct} % (over 100 %)`);
  if (after.pressure_kpa <= 0 || after.pressure_kpa > 1000) errors.push(`pressure ${after.pressure_kpa} kPa`);
  if (errors.length) return { status: 'invalid', errors };
  if (b.text) parsed = { summary: `${hab.name}: ${after.o2_pct} % O₂ at ${after.pressure_kpa} kPa${after.co2_pct ? `, ${after.co2_pct} % CO₂` : ''}${after.he_pct ? `, ${after.he_pct} % He` : ''} (read from your sentence by a simple parser, no AI).` };

  const rows = await Promise.all(m.fuels.map(async (fuel) => {
    const x = await predict({ fuel, o2_pct: hab.o2_pct, pressure_kpa: hab.pressure_kpa }), y = await predict({ fuel, ...after });
    return { fuel, before: x, after: y, change_fuel_burned: r3(y.fuel_burned.mean - x.fuel_burned.mean), change_burning_rate_mm2_s: r3(y.burning_rate_mm2_s.mean - x.burning_rate_mm2_s.mean) };
  }));
  const changes = {};
  [['o2_pct', hab.o2_pct], ['pressure_kpa', hab.pressure_kpa], ['co2_pct', 0], ['he_pct', 0]].forEach(([k, v]) => { if (Math.abs(after[k] - v) > 1e-9) changes[k] = { before: v, after: after[k] }; });
  const before = rerank(rec, b).results, aft = rerank(withAtmosphere(rec, after.o2_pct, after.pressure_kpa), b).results;
  const pos = Object.fromEntries(before.map((r) => [r.id, r]));
  const moved = aft.map((r) => ({ id: r.id, acronym: r.acronym, name: r.name, url: r.url, rank_before: pos[r.id].rank, rank_after: r.rank, rank_change: pos[r.id].rank - r.rank, score_before: pos[r.id].score, score_after: r.score }));
  const warnings = [...new Set(rows.flatMap((f) => f.after.warnings))];
  const worst = [...rows].sort((a, c) => c.change_fuel_burned - a.change_fuel_burned)[0];
  return {
    status: 'ok', parsed, base_habitat: hab, scenario: { ...after, gravity_g: hab.gravity_g, o2_partial_kpa: r3((after.o2_pct / 100) * after.pressure_kpa) }, changes, fuels: rows,
    ranking_top: moved.slice(0, 5), ranking_big_moves: moved.filter((x) => Math.abs(x.rank_change) >= 3).slice(0, 4), warnings,
    explanation: b.explain && worst ? `${worst.fuel} changes most: ${Math.round(worst.before.fuel_burned.mean * 100)} % → ${Math.round(worst.after.fuel_burned.mean * 100)} % of the droplet burned. Studies whose NASA tests ran nearer the new atmosphere move up the ranking.` : null,
    cost_usd: 0,
  };
}

/* ---------------------------------------------------------------- ask: BM25 search over NASA's text */
const STOP = new Set('a an the of in on at to for and or is are was were be been by with from as that this these those it its what which who how why when where do does did can could should would there their them they we you i about into than then so such not no yes any all some more most less much many if your our find found tell explain show mean give list know please'.split(' '));
const tok = (s) => (s.toLowerCase().normalize('NFKD').replace(/[₂]/g, '2').match(/[a-z0-9]+/g) || [])
  .map((w) => w.replace(/(ies)$/, 'y').replace(/(?<=[a-z]{3})s$/, '')).filter((w) => !STOP.has(w));
const SYN = { lunar: ['moon'], moon: ['lunar'], mars: ['martian'], oxygen: ['o2'], o2: ['oxygen'], extinguish: ['extinction', 'suppression'], suppress: ['suppression', 'extinction', 'extinguish'], fire: ['flame', 'combustion'], flame: ['fire'], smoke: ['aerosol', 'soot'], round: ['spherical'], astronaut: ['crew'], difference: ['different', 'compared'], different: ['difference'], gravity: ['microgravity', 'buoyancy'], space: ['microgravity', 'orbit'], earth: ['ground', 'normal'], firefighter: ['earth', 'benefit'], material: ['solid', 'fabric'] };
let indexP = null;
const index = () => (indexP ||= Promise.all([D('passages.json'), D('investigations.json')]).then(([ps, invs]) => {
  const acr = Object.fromEntries(invs.map((i) => [i.id, i]));
  const docs = ps.map((p) => ({ ...p, toks: tok(`${p.file} ${p.text}`), inv: acr[p.investigation_id] }));
  const df = {}; docs.forEach((d) => new Set(d.toks).forEach((w) => { df[w] = (df[w] || 0) + 1; }));
  return { docs, df, avg: docs.reduce((s, d) => s + d.toks.length, 0) / docs.length, invs };
}));
/** Typo tolerance: a word the index has never seen is replaced by the closest known word (1 edit, 2 for long words). */
function editDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i]; let low = i;
    for (let j = 1; j <= b.length; j += 1) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); low = Math.min(low, cur[j]); }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function correct(ix, w) {
  if (ix.df[w] || w.length < 4 || /\d/.test(w)) return w;
  const max = w.length >= 7 ? 2 : 1;
  let best = w, bd = max + 1, bdf = 0;
  for (const [v, n] of Object.entries(ix.df)) {
    const d = editDist(w, v, max);
    if (d < bd || (d === bd && n > bdf)) { best = v; bd = d; bdf = n; }
  }
  return bd <= max ? best : w;
}
const idfOf = (ix, w) => Math.log(1 + (ix.docs.length - (ix.df[w] || 0) + 0.5) / ((ix.df[w] || 0) + 0.5));
function bm25(ix, q, general = false) {
  const N = ix.docs.length;
  return ix.docs.map((d) => {
    const tf = {}; d.toks.forEach((w) => { tf[w] = (tf[w] || 0) + 1; });
    let s = 0;
    for (const [w, wt] of q) {
      if (!tf[w]) continue;
      const idf = Math.log(1 + (N - ix.df[w] + 0.5) / (ix.df[w] + 0.5));
      s += wt * idf * (tf[w] * 2.2) / (tf[w] + 1.2 * (0.25 + 0.75 * d.toks.length / ix.avg));
    }
    // a question naming a study (FLEX, SAFFIRE...) prefers that study's passages
    if (d.inv && q.some(([w]) => d.inv.acronym.toLowerCase().split(/[^a-z0-9-]+/).includes(w))) s *= 1.6;
    if (/^explainer::/.test(d.id) && general) s *= 1.6;   // "what is / why / how" questions prefer the plain-language explainers
    if (/^explainer::/.test(d.id) && general && q.some(([w, wt]) => wt === 1 && tok(d.file).includes(w))) s *= 2;   // explainer whose title names the topic
    if (/::tables::/.test(d.id) && q.some(([w]) => /^(material|fuel|test|burn|burned|tested|sample)$/.test(w))) s *= 1.8;
    return { d, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
}

async function ask(b) {
  const ix = await index(), base = [...new Set(tok(b.question).map((w) => correct(ix, w)))];
  const q = [...base.map((w) => [w, 1]), ...base.flatMap((w) => (SYN[w] || []).map((s) => [s, 0.5]))];
  const namesStudy = base.some((w) => ix.invs.some((i) => i.acronym.toLowerCase().split(/[^a-z0-9-]+/).includes(w)));
  const general = !namesStudy && /^\s*(what|why|how)\b/i.test(b.question) && !/\b(test|tests|tested|which|data|ranges?)\b/i.test(b.question);
  const hits = bm25(ix, q, general).slice(0, b.k || 5);
  const sources = [], lines = [];
  // sentences are scored by the rarity (idf) of the distinct question words they contain
  const weight = Object.fromEntries(q.map(([w, wt]) => [w, wt * idfOf(ix, w)]));
  const scored = hits.map(({ d }) => (/::(publications|team)::/.test(d.id) ? [] : d.text.split(/(?<=[.!?])\s+/))
    .map((sent, j) => { const ws = new Set(tok(sent)); let sc = 0, n = 0; ws.forEach((w) => { if (weight[w]) { sc += weight[w]; if (base.includes(w)) n += 1; } }); return { sent: sent.trim(), sc, n, j }; })
    .filter((x) => x.sc > 0 && x.sent.length > 30));
  const total = base.reduce((a, w) => a + (weight[w] || 0), 0) || 1;
  const bar = Math.max(0.3 * total, 0.55 * Math.max(0, ...scored.flat().map((x) => x.sc)));
  const seen = new Set();
  hits.forEach(({ d }, i) => {
    const label = `S${i + 1}`;
    sources.push({ label, used: false, investigation_id: d.investigation_id, acronym: d.inv?.acronym || d.file.split(' · ')[0], file: d.file, pages: [], chunk_ids: [d.id], hit: d.id, url: d.inv?.url || null });
    const need = Math.min(2, Math.ceil(base.length / 2));
    // a plain-language explainer that matches best is quoted as a whole paragraph
    const good = i === 0 && /^explainer::/.test(d.id) ? d.text.split(/(?<=[.!?])\s+/).slice(0, 5).map((sent) => ({ sent: sent.trim() }))
      : scored[i].filter((x) => x.sc >= bar && x.n >= need).sort((a, c) => c.sc - a.sc).slice(0, i === 0 ? 3 : 1).sort((a, c) => a.j - c.j);
    good.forEach((x) => { if (lines.length < 6 && !seen.has(x.sent)) { seen.add(x.sent); lines.push(`${x.sent} [${label}]`); sources[i].used = true; } });
  });
  let graph = null;
  if (b.graph) {
    const facts = (await D('facts.json')).map((f) => ({ f, k: tok(f.text).filter((w) => base.includes(w) || base.some((x) => (SYN[x] || []).includes(w))).length })).filter((x) => x.k > 0).sort((a, c) => c.k - a.k).slice(0, 12);
    if (facts.length) {
      graph = { n_facts: facts.length };
      sources.push({ label: 'G', kind: 'graph', used: true, text: facts.map((x) => x.f.text).join('\n'), file: 'Facts extracted from NASA PSI records and test tables' });
      lines.unshift(`Linked facts from the NASA tables: ${facts.slice(0, 4).map((x) => x.f.text).join('; ')} [G]`);
    }
  }
  const ok = lines.length > 0 && hits[0]?.s > 1.5;
  return {
    question: b.question, sources, removed_sentences: [], graph,
    status: ok ? (lines.length < 2 ? 'partial' : 'answered') : 'not_in_sources', answerable: ok,
    answer: ok
      ? `Quoted from the sources below (search, no AI):\n\n${lines.map((l) => `- ${l}`).join('\n')}`
      : `I could not find this in the 24 NASA combustion records. Try naming a study (FLEX, SAFFIRE, BASS, ACME…) or a topic such as oxygen, extinction, smoke or materials.${hits.length ? ` Closest passage: ${hits[0].d.file} [S1].` : ''}`,
  };
}

async function passage(id) {
  const m = String(id).match(/^(PSI-\d+)::row::(\d+)$/);
  if (m) {
    const d = await D(`investigation/${m[1]}.json`), e = d.experiments[+m[2]];
    if (!e) throw new Error(`Test row ${id} not found.`);
    return { text: e.evidence, chunk_ids: [id], hit: id, file: `${d.acronym} · NASA experimental table`, pages: [] };
  }
  const p = (await D('passages.json')).find((x) => x.id === id);
  if (!p) throw new Error(`Passage ${id} not found.`);
  return { text: p.text, chunk_ids: [id], hit: id, file: p.file, pages: [] };
}

/* ---------------------------------------------------------------- materials screening (rule-based, any CSV) */
const MATERIAL_KEYS = [
  ['pmma', /pmma|acrylic|plexiglas/i], ['sibal', /sibal|cotton.?fiberglass|cotton.?fibreglass/i], ['silicone', /silicone/i], ['nomex', /nomex|aramid/i],
  ['kapton', /kapton|polyimide/i], ['teflon', /teflon|ptfe/i], ['cotton', /cotton|lampwick/i], ['nylon', /nylon/i], ['polyethylene', /polyethylene|\bpe\b/i],
];
function splitCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const delim = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const cells = (l) => { const out = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === delim && !q) { out.push(c.trim()); c = ''; } else c += ch; } out.push(c.trim()); return out; };
  return [cells(lines[0]), lines.slice(1).map(cells)];
}
async function materialsUpload(file) {
  const [head, rows] = splitCsv(await file.text()), [habitats, ref] = await Promise.all([D('habitats.json'), D('materials-ref.json')]);
  const col = (rx) => head.findIndex((h) => rx.test(h));
  const c = { id: col(/^id$/i), name: col(/^(material|name)$/i), cls: col(/categor|class|type/i), loi: col(/loi|oxygen index/i), t1: col(/6001|test ?1|upward/i), th: col(/thick/i) };
  if (c.id < 0) throw new Error('The file needs an “id” column.');
  const used = new Set(Object.values(c).filter((j) => j >= 0));
  const columns_dropped = head.map((h, j) => (used.has(j) ? null : { column: h || `column ${j + 1}`, reason: h ? 'not used by the screening rules' : 'row index' })).filter(Boolean);
  const maxO2 = Math.max(...habitats.map((h) => h.o2_pct)), ids = new Set(), dup = [];
  const results = rows.map((r) => {
    const id = r[c.id], name = c.name >= 0 ? r[c.name] : '', loi = c.loi >= 0 && r[c.loi] !== '' ? parseFloat(r[c.loi]) : null, t1 = c.t1 >= 0 ? (r[c.t1] || '').toLowerCase() : '';
    if (ids.has(id)) dup.push(id); ids.add(id);
    const key = MATERIAL_KEYS.find(([, rx]) => rx.test(name));
    const nasa = key ? ref.filter((x) => key[1].test(x.material) || (key[0] === 'cotton' && /sibal|lampwick/i.test(x.material))).sort((a, b) => key[1].test(b.material) - key[1].test(a.material)) : [];
    const sources = [...new Map(nasa.map((x) => [x.acronym, x])).values()].slice(0, 3).map((x, i) => ({ label: `S${i + 1}`, acronym: x.acronym, investigation_id: x.investigation_id, file: `${x.acronym} · NASA experimental table (${x.material})`, chunk_id: x.chunk_id, chunk_ids: [x.chunk_id] }));
    const reasons = [], flags = [], missing = [];
    const valid = loi != null && Number.isFinite(loi);
    if (valid) reasons.push({ text: `Oxygen index ${loi} %: ${loi > maxO2 ? `above every habitat’s cabin O₂ (max ${maxO2} %)` : loi > 21 ? `self-extinguishes in sea-level air but not above ${loi} % O₂` : 'burns in ordinary air (21 % O₂)'}.`, sources: ['row'] });
    else missing.push('Limiting oxygen index (LOI, %)');
    if (t1.startsWith('pass')) reasons.push({ text: 'Passed NASA-STD-6001 Test 1 (upward flammability).', sources: ['row'] });
    else if (t1.startsWith('fail')) reasons.push({ text: 'Failed NASA-STD-6001 Test 1 (upward flammability).', sources: ['row'] });
    else missing.push('NASA-STD-6001 Test 1 result at the worst-case atmosphere');
    if (sources.length) reasons.push({ text: `NASA burned ${key[0] === 'cotton' ? 'a cotton blend' : key[0].toUpperCase() === key[0] ? key[0] : name.split(/[ (]/)[0]} in ${sources.map((s) => s.acronym).join(', ')}.`, sources: sources.map((s) => s.label) });
    if (valid && loi >= 30 && t1.startsWith('fail')) flags.push(`High LOI (${loi} %) but failed Test 1: check the data; the upward test is the stricter one.`);
    if (valid && (loi < 10 || loi > 100)) flags.push(`LOI ${loi} % is outside the physical range.`);
    let risk;
    if (!valid && !t1) risk = 'unknown';
    else if (t1.startsWith('fail') && (!valid || loi < maxO2)) risk = 'high';
    else if (valid && loi <= 21) risk = 'high';
    else if (t1.startsWith('fail') || (valid && loi <= maxO2) || !t1 || !valid) risk = 'medium';
    else risk = 'low';
    const known = [valid, !!t1, sources.length > 0].filter(Boolean).length;
    return {
      id, material: name, material_class: c.cls >= 0 ? r[c.cls] : '', risk_level: risk, confidence: known >= 3 ? 'high' : known === 2 ? 'medium' : 'low',
      matched_nasa_material: sources.length ? nasa[0].material : null, match_quality: !sources.length ? 'none' : name.toLowerCase().includes(key[0]) && key[1].test(nasa[0].material) ? 'same' : 'similar',
      reasons, flags, missing_data: missing, loi_pct: valid ? loi : null, sources,
      nasa_relevance: sources.length ? `Burned or heated in ${[...new Set(nasa.map((x) => x.acronym))].join(', ')}: ${[...new Set(nasa.map((x) => x.material))].slice(0, 4).join('; ')}.` : null,
      loi_by_habitat: valid ? habitats.map((h) => ({ habitat_id: h.id, habitat: h.name, o2_pct: h.o2_pct, status: loi > h.o2_pct ? 'self-extinguishes' : 'may burn' })) : [],
    };
  });
  const summary = { high: 0, medium: 0, low: 0, unknown: 0 }; results.forEach((m) => { summary[m.risk_level] += 1; });
  const res = { file: file.name, n_rows: results.length, duplicate_ids: dup, columns_dropped, summary, flagged: results.filter((m) => m.flags.length).map((m) => m.id), cost_usd: 0, new_llm_calls: 0, results };
  res.report_url = URL.createObjectURL(new Blob([report(res, habitats)], { type: 'text/html' }));
  return res;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
function report(r, habitats) {
  const row = (m) => `<tr class="${m.risk_level}"><td><b>${esc(m.id)}</b> ${esc(m.material)}</td><td>${m.risk_level}</td><td>${m.confidence}</td><td>${m.loi_pct ?? '—'}</td>${habitats.map((h) => `<td>${m.loi_by_habitat.find((x) => x.habitat_id === h.id)?.status ?? '—'}</td>`).join('')}<td>${m.reasons.map((x) => esc(x.text)).join('<br>')}${m.flags.map((f) => `<br><i>⚠ ${esc(f)}</i>`).join('')}</td></tr>`;
  return `<!doctype html><meta charset="utf-8"><title>FlameX materials screening</title><style>body{font:14px system-ui;margin:24px;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left;vertical-align:top}.high td:nth-child(2){color:#b00020;font-weight:600}.medium td:nth-child(2){color:#a85b00}.low td:nth-child(2){color:#1b7a3a}</style>
<h1>Materials fire-risk screening</h1><p>${esc(r.file)} · ${r.n_rows} materials · high ${r.summary.high}, medium ${r.summary.medium}, low ${r.summary.low}, unknown ${r.summary.unknown}</p>
<p>Rules: oxygen index (LOI) against each habitat's cabin O₂, NASA-STD-6001 Test 1 result, and matches to materials NASA burned in SAFFIRE, BASS and SAME (NASA PSI). A screening aid, not a certification.</p>
<table><tr><th>Material</th><th>Risk</th><th>Confidence</th><th>LOI %</th>${habitats.map((h) => `<th>${esc(h.name)}<br>${h.o2_pct} % O₂</th>`).join('')}<th>Why</th></tr>${r.results.map(row).join('')}</table>`;
}

export const demoApi = {
  habitats: () => D('habitats.json'),
  investigations: () => D('investigations.json'),
  investigation: (id) => D(`investigation/${id}.json`),
  compare: (ids) => Promise.all(ids.map((id) => D(`investigation/${id}.json`))),
  rank: async (b) => rerank(await D(`rank/${b.habitat_id}.json`), b),
  ask,
  retrieve: async (b) => bm25(await index(), tok(b.question).map((w) => [w, 1])).slice(0, b.k || 5).map(({ d, s }) => ({ ...d, toks: undefined, inv: undefined, score: r3(s) })),
  passage,
  fuels: async () => (await model()).fuels,
  predict,
  flammap,
  gaps,
  whatif,
  materialsUpload,
  absolute: (path) => path || null,
  sampleCsv: `${ROOT}materials_test.csv`,
  meta: () => D('meta.json'),
};
