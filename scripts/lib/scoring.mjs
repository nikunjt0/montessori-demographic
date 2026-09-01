// Factor derivation and normalisation for the site score.

/**
 * Competitor weight by facility type — how directly each one takes an
 * infant-to-6yo Montessori enrolment.
 *
 * Licensed capacity comes from DCFS, so these weight *real* slots rather than
 * guesses. In-home day care (DCH) is discounted: it competes hard for infants
 * and toddlers but much less for a structured Montessori preschool program.
 *
 * K-12 schools carry weight 0 — they are counted and displayed as neighbourhood
 * context, but a nearby elementary school is not childcare capacity, and
 * treating it as competition would be wrong in both directions (a good school
 * is a reason families move in).
 */
export const COMPETITOR_WEIGHT = {
  montessori: 1.0,
  center: 1.0,
  group_home: 0.8,
  home: 0.55,
  school: 0,
};

/**
 * Weighted, age-adjusted slots a facility contributes.
 * `ageFactor` is the share of the 0–6 band the licence actually covers, so a
 * 3-to-5 preschool counts for a third of what a 6-week-to-6-year centre does.
 */
export function slotsOf(facility) {
  const weight = COMPETITOR_WEIGHT[facility.kind] ?? 0;
  if (!weight) return 0;
  return (facility.capacity ?? 0) * (facility.ageFactor ?? 1) * weight;
}

/**
 * Smoothing constant (in "slots") for the kids-per-slot ratio. Without it, a
 * block group with zero nearby capacity divides by zero and dominates the
 * ranking on a technicality.
 */
export const SLOT_SMOOTHING = 25;

/** Linear interpolation across (x, y) control points, clamped at both ends. */
function interp(points, x) {
  if (x === null || !Number.isFinite(x)) return null;
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}

/**
 * Mid-market income desirability, 0–1.
 *
 * Not monotonic: below ~$70k full-freight Montessori tuition is out of reach
 * for most households, and above ~$220k families increasingly hire nannies or
 * choose established private schools instead. The plateau is the sweet spot.
 */
export function incomeCurve(medianHhIncome) {
  return interp(
    [
      [35_000, 0.08],
      [55_000, 0.30],
      [75_000, 0.62],
      [95_000, 0.85],
      [115_000, 1.0],
      [165_000, 1.0],
      [200_000, 0.86],
      [250_000, 0.68],
      [325_000, 0.55],
    ],
    medianHhIncome
  );
}

/** Safe ratio helper: returns null rather than NaN/Infinity on bad input. */
export function ratio(numerator, denominator) {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * Percentile rank (0–100) of every value in `values`, using average ranks for
 * ties. Nulls stay null and are excluded from the ranking entirely, so missing
 * data never silently scores as zero.
 */
export function percentileRanks(values) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => v !== null && Number.isFinite(v));
  idx.sort((a, b) => a[0] - b[0]);

  const out = new Array(values.length).fill(null);
  const n = idx.length;
  if (n === 0) return out;
  if (n === 1) { out[idx[0][1]] = 50; return out; }

  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; // tie run [i..j]
    const avgRank = (i + j) / 2;
    const pct = (avgRank / (n - 1)) * 100;
    for (let k = i; k <= j; k++) out[idx[k][1]] = +pct.toFixed(2);
    i = j + 1;
  }
  return out;
}

/**
 * The scoring factors, in the order they appear in the UI.
 * `invert: true` means a LOW raw value is good.
 */
export const FACTORS = [
  { key: "careNeed",    label: "Working-parent demand", help: "Children under 6 within 1 mile whose available parents are all in the labor force — the households that structurally need full-day care." },
  { key: "kidDensity",  label: "Young-child density",   help: "Children aged 0–4 within 1 mile. Raw size of the infant-through-preschool market." },
  { key: "supplyGap",   label: "Supply gap (1 mi)",     help: "Children needing care per existing childcare slot within 1 mile. High means underserved." },
  { key: "supplyGap3",  label: "Supply gap (3 mi)",     help: "Same ratio measured at 3 miles. Catches areas that look empty at 1 mile only because they sit beside a saturated neighbor." },
  { key: "growth",      label: "New construction",      help: "Share of housing built since 2010, blended with population change since the 2020 census. This is the new-subdivision signal." },
  { key: "income",      label: "Income fit",            help: "How well median household income matches mid-market Montessori tuition. Peaks around $115k–$165k." },
  { key: "education",   label: "Parent education",      help: "Share of adults 25+ with a bachelor's degree or higher — the strongest correlate of demand for Montessori specifically." },
  { key: "families",    label: "Family households",     help: "Share of households that are families with children under 18, plus owner-occupancy (a proxy for settled, long-tenure families)." },
];

/** Default weights, summing to 1. Tuned for a mid-market Montessori + daycare. */
export const DEFAULT_WEIGHTS = {
  careNeed: 0.22,
  kidDensity: 0.15,
  supplyGap: 0.20,
  supplyGap3: 0.07,
  growth: 0.14,
  income: 0.12,
  education: 0.05,
  families: 0.05,
};

/**
 * Weighted composite of the per-factor percentile scores.
 * Missing factors are dropped and the remaining weights renormalised, so a
 * block group is never penalised for a gap in the source data.
 */
export function composite(scores, weights) {
  let sum = 0, used = 0;
  for (const { key } of FACTORS) {
    const s = scores[key];
    const w = weights[key] ?? 0;
    if (s === null || s === undefined || w === 0) continue;
    sum += s * w;
    used += w;
  }
  return used === 0 ? null : +(sum / used).toFixed(2);
}
