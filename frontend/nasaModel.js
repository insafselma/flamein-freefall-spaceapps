// Droplet-flame model fitted on NASA's FLEX tests (PSI-69), plus the "closeness" score used by the ranking.
// Shared by the browser (demo.js) and the build script, so both always give the same numbers.
//
// Model: Gaussian-kernel regression (Nadaraya–Watson) per fuel. A prediction is the weighted mean of the
// measured outcomes of NASA tests, weighted by how close each test's conditions are to the query:
//   distance² = (ΔO₂ / 2 %)² + (Δln p / 0.2)² + (ΔCO₂ / 8 %)² + (ΔHe / 16 %)² + (Δd₀ / 0.5 mm)²
// The scales were chosen by leave-one-out validation on the tests themselves (see `validate`).
// The 90 % band combines the spread of nearby outcomes, the effective number of nearby tests, and a
// penalty that grows with the distance to the nearest test (extrapolation).
// Target: fuel burned = 1 − (d_ext / d₀)³ (share of the droplet's mass burned before the flame went out);
// tests that ended by completion count as 1; tests that ended in droplet disruption are left out.

/** Ranking criteria, and the priorities the dashboards start with. */
export const CRITERIA = ['flammability', 'detection', 'suppression', 'physics', 'closeness'];
export const DEFAULT_PRIORITIES = { flammability: 2, detection: 2, suppression: 2, physics: 3, closeness: 3 };

export const SCALE = { o2: 2, logp: 0.2, co2: 8, he: 16, d0: 0.5 };
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const r3 = (x) => Math.round(x * 1000) / 1000;

function vec(t, withD0) {
  const v = [t.o2_pct / SCALE.o2, Math.log(t.pressure_kpa) / SCALE.logp, (t.co2_pct || 0) / SCALE.co2, (t.he_pct || 0) / SCALE.he];
  if (withD0) v.push(t.d0_mm / SCALE.d0);
  return v;
}
const d2 = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);

function kernel(tests, key, q, withD0) {
  const pts = tests.filter((t) => t[key] != null && (!withD0 || t.d0_mm != null));
  if (!pts.length) return null;
  const qv = vec(q, withD0), ds = pts.map((t) => d2(vec(t, withD0), qv)), m = Math.min(...ds);
  let W = 0, W2 = 0, Y = 0;
  const w = ds.map((d) => Math.exp(-0.5 * (d - m)));      // shifted for numerical safety; normalised below
  w.forEach((wi, i) => { W += wi; W2 += wi * wi; Y += wi * pts[i][key]; });
  const mean = Y / W;
  let V = 0; w.forEach((wi, i) => { V += wi * (pts[i][key] - mean) ** 2; });
  return { mean, var: V / W, neff: (W * W) / W2, dmin: Math.sqrt(m) };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

export function makeModel(allTests) {
  const byFuel = {};
  allTests.forEach((t) => { (byFuel[t.fuel] ||= []).push(t); });
  const info = Object.fromEntries(Object.entries(byFuel).map(([f, ts]) => {
    const o = ts.map((t) => t.o2_pct), p = ts.map((t) => t.pressure_kpa);
    return [f, {
      n: ts.length, n_outcomes: ts.filter((t) => t.fuel_burned != null).length, d0_median: median(ts.map((t) => t.d0_mm).filter(Boolean)),
      o2_pct: [Math.min(...o), Math.max(...o)], pressure_kpa: [Math.min(...p), Math.max(...p)],
      co2_max: Math.max(...ts.map((t) => t.co2_pct || 0)), he_max: Math.max(...ts.map((t) => t.he_pct || 0)),
    }];
  }));

  /** Distance (in model units) from the query to the nearest test of this fuel, ignoring droplet size. */
  const distance = (fuel, q) => Math.sqrt(Math.min(...byFuel[fuel].map((t) => d2(vec(t, false), vec(q, false)))));

  function predict(fuel, q) {
    const ts = byFuel[fuel]; if (!ts) throw new Error(`No NASA tests for ${fuel}. Available: ${Object.keys(byFuel).join(', ')}.`);
    const query = { ...q, d0_mm: q.d0_mm || info[fuel].d0_median };
    const fb = kernel(ts, 'fuel_burned', query, true), k = kernel(ts, 'k_mm2_s', query, true);
    const dist = distance(fuel, query);
    const band = (r, floor, scale) => { const sd = Math.sqrt(r.var + (r.var + floor) / r.neff + (scale * dist) ** 2); return sd; };
    const sF = band(fb, 0.005, 0.06), sK = band(k, 0.001, 0.03);
    return {
      fuel_burned: { mean: r3(clamp(fb.mean)), low: r3(clamp(fb.mean - 1.645 * sF)), high: r3(clamp(fb.mean + 1.645 * sF)) },
      burning_rate_mm2_s: { mean: r3(k.mean), low: r3(Math.max(0, k.mean - 1.645 * sK)), high: r3(k.mean + 1.645 * sK) },
      distance: r3(dist), neff: r3(fb.neff), d0_mm: query.d0_mm,
    };
  }

  function nearest(fuel, q, n = 3) {
    return byFuel[fuel].map((t) => ({ t, d: Math.sqrt(d2(vec(t, false), vec(q, false))) })).sort((a, b) => a.d - b.d).slice(0, n);
  }

  /** Leave-one-out check on the tests themselves: mean absolute error of fuel burned, vs always guessing the fuel's mean. */
  function validate() {
    const out = {};
    for (const [f, ts] of Object.entries(byFuel)) {
      const y = ts.filter((t) => t.fuel_burned != null && t.d0_mm != null), mu = y.reduce((s, t) => s + t.fuel_burned, 0) / y.length;
      let e = 0, b = 0, inside = 0;
      y.forEach((t, i) => {
        const rest = ts.filter((x) => x !== t), r = kernel(rest, 'fuel_burned', t, true);
        e += Math.abs(r.mean - t.fuel_burned); b += Math.abs(mu - t.fuel_burned);
        const sd = Math.sqrt(r.var + (r.var + 0.005) / r.neff + (0.06 * r.dmin) ** 2);
        if (Math.abs(r.mean - t.fuel_burned) <= 1.645 * sd) inside += 1;
      });
      out[f] = { n: y.length, mae: r3(e / y.length), baseline_mae: r3(b / y.length), band_coverage: r3(inside / y.length) };
    }
    return out;
  }

  return { fuels: Object.keys(byFuel).sort(), info, byFuel, predict, nearest, distance, validate };
}

/* ------------------------------------------------------------------ ranking: how close NASA's tested atmospheres are to a habitat */
const gap = (v, lo, hi) => (v < lo ? lo - v : v > hi ? v - hi : 0);
/** ranges: [[o2_min, o2_max, p_min|null, p_max|null], ...] from an investigation's test rows. */
export function closeness(ranges, o2, p) {
  if (!ranges?.length) return { score: 0.1, reason: 'NASA’s table for this study lists no oxygen or pressure values.' };
  let best = Infinity, row = null;
  for (const r of ranges) {
    const dO = gap(o2, r[0], r[1]) / 5;
    const dP = r[2] != null ? gap(Math.log(p), Math.log(r[2]), Math.log(r[3])) / Math.log(1.5) : 0.8;   // unknown pressure counts as a moderate gap
    const d = Math.hypot(dO, dP); if (d < best) { best = d; row = r; }
  }
  const f = (a, b, u) => (a === b ? `${a}${u}` : `${a}–${b}${u}`);
  return {
    score: Math.round(Math.exp(-0.5 * best * best) * 100) / 100,
    reason: `Closest NASA test: ${f(row[0], row[1], ' % O₂')}${row[2] != null ? ` at ${f(row[2], row[3], ' kPa')}` : ' (pressure not listed)'} vs ${o2} % at ${p} kPa (${ranges.length} distinct conditions).`,
  };
}
