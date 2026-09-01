// Step 4: join geometry + census + competitors, compute 1mi/3mi catchment
// aggregates, and emit the scored GeoJSON the map consumes.
//
//   node scripts/build.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { PATHS, RADII, HOME_BASE, ACS_YEAR, COUNTIES } from "./lib/config.mjs";
import { GridIndex, haversineMiles, bbox } from "./lib/geo.mjs";
import {
  COMPETITOR_WEIGHT, SLOT_SMOOTHING, slotsOf, incomeCurve, ratio,
  percentileRanks, FACTORS, DEFAULT_WEIGHTS, composite,
} from "./lib/scoring.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const geometry = read(PATHS.geometry);
const census = read(PATHS.census);

/**
 * Supply = DCFS licensed providers (the real childcare capacity) + OSM K-12
 * schools (context only). OSM's own childcare entries are deliberately dropped:
 * they duplicate DCFS badly and miss licensed in-home providers entirely.
 */
const dcfs = read(PATHS.dcfs);
const osmSchools = read(PATHS.supply).filter((f) => f.kind === "school");
let supply = [...dcfs, ...osmSchools];
console.log(`Supply: ${dcfs.length} DCFS licensed providers + ${osmSchools.length} OSM schools.`);

// ---------------------------------------------------------------------------
// Hand corrections from data/competitor-overrides.csv
// ---------------------------------------------------------------------------
function applyOverrides(list) {
  if (!existsSync(PATHS.overrides)) return list;
  const lines = readFileSync(PATHS.overrides, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("action,"));

  let added = 0, removed = 0;
  for (const line of lines) {
    const [action, name, kind, lat, lon, capacity] = line.split(",").map((s) => s?.trim());
    if (action === "add") {
      list.push({
        osmId: `manual/${name}`, name, kind: kind || "center",
        lat: Number(lat), lon: Number(lon),
        capacity: Number(capacity) || 80,
        ageFactor: 1,
        operator: null, city: null, street: null, source: "manual",
      });
      added++;
    } else if (action === "remove") {
      const needle = name.toLowerCase();
      const before = list.length;
      list = list.filter((f) => {
        if (!f.name.toLowerCase().includes(needle)) return true;
        if (lat && lon && haversineMiles([f.lon, f.lat], [Number(lon), Number(lat)]) > 0.5) return true;
        return false;
      });
      removed += before - list.length;
    }
  }
  if (added || removed) console.log(`Overrides applied: +${added} added, -${removed} removed.`);
  return list;
}
supply = applyOverrides(supply);

// ---------------------------------------------------------------------------
// Per-block-group raw metrics
// ---------------------------------------------------------------------------
const rows = [];
let missingCensus = 0;

for (const f of geometry.features) {
  const c = census[f.properties.geoid];
  if (!c) { missingCensus++; continue; }

  const kids0to4 = (c.maleUnder5 ?? 0) + (c.femaleUnder5 ?? 0);
  const kids5to9 = (c.male5to9 ?? 0) + (c.female5to9 ?? 0);

  // Children under 6 whose available parents are ALL working: two-parent
  // households with both in the labor force, plus single-parent households
  // where that parent works. This is the population that must buy care.
  const careNeed =
    (c.kidsUnder6BothParentsLF ?? 0) + (c.kidsUnder6DadOnlyLF ?? 0) + (c.kidsUnder6MomOnlyLF ?? 0);

  const newHousingShare = ratio((c.built2020plus ?? 0) + (c.built2010to2019 ?? 0), c.housingUnits);
  const popGrowth = ratio((c.pop ?? 0) - (c.pop2020 ?? 0), c.pop2020);
  const ownerShare = ratio(c.ownerOccupied, c.tenureTotal);
  const eduShare = ratio(
    (c.eduBachelors ?? 0) + (c.eduMasters ?? 0) + (c.eduProfessional ?? 0) + (c.eduDoctorate ?? 0),
    c.eduTotal
  );
  const kidsHhShare = ratio(c.hhWithKidsUnder18, c.households);
  const povertyRate = ratio(c.povertyBelow, c.povertyUniverse);

  rows.push({
    feature: f,
    geoid: f.properties.geoid,
    county: f.properties.county,
    place: f.properties.place,
    lon: f.properties.lon,
    lat: f.properties.lat,
    landSqMi: f.properties.landSqMi,
    pop: c.pop, pop2020: c.pop2020,
    medianHhIncome: c.medianHhIncome,
    medianHomeValue: c.medianHomeValue,
    households: c.households,
    kids0to4, kids5to9, careNeed,
    kidsUnder6InFamilies: c.kidsUnder6InFamilies,
    housingUnits: c.housingUnits,
    newHousingShare, popGrowth, ownerShare, eduShare, kidsHhShare, povertyRate,
    homeMiles: +haversineMiles([f.properties.lon, f.properties.lat], HOME_BASE.lonLat).toFixed(2),
  });
}
console.log(`Joined ${rows.length} block groups (${missingCensus} had no census match).`);

// ---------------------------------------------------------------------------
// Impute missing median income from nearby block groups.
// ACS suppresses medians in sparsely populated block groups; leaving them null
// drops the income factor entirely for ~9% of the map.
// ---------------------------------------------------------------------------
const incomeIndex = new GridIndex(rows.filter((r) => r.medianHhIncome !== null));
let imputed = 0;
for (const r of rows) {
  if (r.medianHhIncome !== null) { r.incomeImputed = false; continue; }
  const near = incomeIndex.within([r.lon, r.lat], 1.5);
  if (near.length) {
    r.medianHhIncome = Math.round(near.reduce((s, n) => s + n.medianHhIncome, 0) / near.length);
    r.incomeImputed = true;
    imputed++;
  } else {
    r.incomeImputed = false;
  }
}
console.log(`Imputed median income for ${imputed} block groups from neighbours within 1.5 mi.`);

// ---------------------------------------------------------------------------
// Catchment aggregation: 1 mile is the catchment parents actually use; 3 miles
// is context. See data/README for why 1 mile dominates the weighting.
// ---------------------------------------------------------------------------
const bgIndex = new GridIndex(rows);
const supplyIndex = new GridIndex(supply);

for (const r of rows) {
  for (const [label, miles] of [["1", RADII.primary], ["3", RADII.secondary]]) {
    const bgs = bgIndex.within([r.lon, r.lat], miles);
    r[`careNeed${label}mi`] = bgs.reduce((s, b) => s + b.careNeed, 0);
    r[`kids0to4_${label}mi`] = bgs.reduce((s, b) => s + b.kids0to4, 0);
    r[`kids5to9_${label}mi`] = bgs.reduce((s, b) => s + b.kids5to9, 0);

    const comps = supplyIndex.within([r.lon, r.lat], miles);
    r[`slots${label}mi`] = Math.round(comps.reduce((s, f) => s + slotsOf(f), 0));
    r[`competitors${label}mi`] = comps.filter((f) => f.kind !== "school").length;
    r[`homes${label}mi`] = comps.filter((f) => f.kind === "home" || f.kind === "group_home").length;
    r[`centers${label}mi`] = comps.filter((f) => f.kind === "center").length;
    r[`montessori${label}mi`] = comps.filter((f) => f.kind === "montessori").length;
    r[`schools${label}mi`] = comps.filter((f) => f.kind === "school").length;
  }

  // Children needing care per weighted slot. Smoothing scales with the
  // catchment so a zero-supply 3-mile ring is not treated like a zero-supply
  // 1-mile ring.
  r.kidsPerSlot1mi = +(r.careNeed1mi / (r.slots1mi + SLOT_SMOOTHING)).toFixed(3);
  r.kidsPerSlot3mi = +(r.careNeed3mi / (r.slots3mi + SLOT_SMOOTHING * 3)).toFixed(3);
}

// ---------------------------------------------------------------------------
// Factor scores (percentile ranks, 0-100)
// ---------------------------------------------------------------------------
const col = (fn) => rows.map(fn);
const pct = (fn) => percentileRanks(col(fn));

const pNewHousing = pct((r) => r.newHousingShare);
const pPopGrowth = pct((r) => r.popGrowth);
const pKidsHh = pct((r) => r.kidsHhShare);
const pOwner = pct((r) => r.ownerShare);

/** Blend two percentile columns, tolerating nulls on either side. */
const blend = (a, b, wa, i) => {
  const x = a[i], y = b[i];
  if (x === null && y === null) return null;
  if (x === null) return y;
  if (y === null) return x;
  return +(x * wa + y * (1 - wa)).toFixed(2);
};

const scoreCols = {
  careNeed: pct((r) => r.careNeed1mi),
  kidDensity: pct((r) => r.kids0to4_1mi),
  supplyGap: pct((r) => r.kidsPerSlot1mi),
  supplyGap3: pct((r) => r.kidsPerSlot3mi),
  // New construction: housing built since 2010 is the durable signal; growth
  // since the 2020 census catches subdivisions that filled in very recently.
  growth: rows.map((_, i) => blend(pNewHousing, pPopGrowth, 0.6, i)),
  income: pct((r) => incomeCurve(r.medianHhIncome)),
  education: pct((r) => r.eduShare),
  families: rows.map((_, i) => blend(pKidsHh, pOwner, 0.6, i)),
};

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
const round = (v, d = 3) => (v === null || v === undefined ? null : +v.toFixed(d));

/**
 * Two outputs, deliberately split:
 *
 *  blockgroups.json — geometry plus only the properties the MAP needs (paint,
 *                     filter, hover). MapLibre loads this by URL so the whole
 *                     parse happens in its worker, off the main thread.
 *  scores.json      — full properties per block group, no geometry, for the
 *                     ranked list, the detail panel and live re-scoring.
 *
 * Previously the app parsed one 3.9 MB file on the main thread, held it in
 * React state, and then structured-cloned it into the MapLibre worker.
 */
const outFeatures = [];
const outScores = [];

rows.forEach((r, i) => {
  const scores = {};
  for (const { key } of FACTORS) scores[key] = scoreCols[key][i];
  const score = composite(scores, DEFAULT_WEIGHTS);

  const [minX, minY, maxX, maxY] = bbox(r.feature.geometry);

  // Everything the map itself reads: paint, filter, hover popup.
  outFeatures.push({
    type: "Feature",
    id: r.geoid,
    properties: {
      geoid: r.geoid,
      county: r.county,
      place: r.place,
      score,
      kids0to4_1mi: r.kids0to4_1mi,
      homeMiles: r.homeMiles,
      competitors1mi: r.competitors1mi,
      kidsPerSlot1mi: r.kidsPerSlot1mi,
    },
    geometry: r.feature.geometry,
  });

  outScores.push({
    geoid: r.geoid,
    county: r.county,
    place: r.place,
    lon: r.lon,
    lat: r.lat,
    ...scores,
    score,
    bbox: [+minX.toFixed(5), +minY.toFixed(5), +maxX.toFixed(5), +maxY.toFixed(5)],
    pop: r.pop,
    medianHhIncome: r.medianHhIncome,
    incomeImputed: r.incomeImputed,
    medianHomeValue: r.medianHomeValue,
    kids0to4: r.kids0to4,
    kids5to9: r.kids5to9,
    kids0to4_1mi: r.kids0to4_1mi,
    kids5to9_1mi: r.kids5to9_1mi,
    careNeed1mi: r.careNeed1mi,
    careNeed3mi: r.careNeed3mi,
    slots1mi: r.slots1mi,
    slots3mi: r.slots3mi,
    competitors1mi: r.competitors1mi,
    centers1mi: r.centers1mi,
    homes1mi: r.homes1mi,
    competitors3mi: r.competitors3mi,
    montessori1mi: r.montessori1mi,
    schools1mi: r.schools1mi,
    kidsPerSlot1mi: r.kidsPerSlot1mi,
    kidsPerSlot3mi: r.kidsPerSlot3mi,
    newHousingShare: round(r.newHousingShare),
    popGrowth: round(r.popGrowth),
    ownerShare: round(r.ownerShare),
    eduShare: round(r.eduShare),
    kidsHhShare: round(r.kidsHhShare),
    povertyRate: round(r.povertyRate),
    homeMiles: r.homeMiles,
  });
});

// A raw metric sharing a name with a FACTOR key would silently overwrite that
// factor's percentile and push composites above 100. Fail loudly instead.
const factorKeys = new Set(FACTORS.map((f) => f.key));
for (const s of outScores) {
  for (const key of factorKeys) {
    const v = s[key];
    if (v !== null && (v < 0 || v > 100)) {
      throw new Error(
        `Factor "${key}" on ${s.geoid} is ${v}, outside 0-100. ` +
        `A raw property is probably colliding with a factor key.`
      );
    }
  }
}

writeFileSync(PATHS.outBlockGroups, JSON.stringify({ type: "FeatureCollection", features: outFeatures }));
writeFileSync(PATHS.outScores, JSON.stringify(outScores));
// Emitted as GeoJSON so MapLibre can load it straight from the URL.
writeFileSync(
  PATHS.outSupply,
  JSON.stringify({
    type: "FeatureCollection",
    features: supply.map((f) => ({
      type: "Feature",
      properties: f,
      geometry: { type: "Point", coordinates: [f.lon, f.lat] },
    })),
  })
);
writeFileSync(
  PATHS.outMeta,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    acsYear: ACS_YEAR,
    counties: Object.values(COUNTIES),
    radii: RADII,
    homeBase: HOME_BASE,
    blockGroups: outFeatures.length,
    facilities: supply.length,
    factors: FACTORS,
    defaultWeights: DEFAULT_WEIGHTS,
    competitorWeight: COMPETITOR_WEIGHT,
  }, null, 2)
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const sizeMb = (p) => (readFileSync(p).length / 1e6).toFixed(2);
console.log(`\nWrote ${PATHS.outBlockGroups} (${sizeMb(PATHS.outBlockGroups)} MB, map geometry)`);
console.log(`Wrote ${PATHS.outScores} (${sizeMb(PATHS.outScores)} MB, full properties)`);
console.log(`Wrote ${PATHS.outSupply} (${sizeMb(PATHS.outSupply)} MB, ${supply.length} facilities)`);

const ranked = [...outScores]
  .filter((p) => p.score !== null && p.kids0to4_1mi >= 150)
  .sort((a, b) => b.score - a.score)
  .map((properties) => ({ properties }));

console.log(`\nTop 15 block groups (composite score, default weights, >=150 kids 0-4 within 1 mi):`);
console.table(
  ranked.slice(0, 15).map((f) => {
    const p = f.properties;
    return {
      place: p.place,
      county: p.county,
      score: p.score,
      "kids0-4 1mi": p.kids0to4_1mi,
      "careNeed 1mi": p.careNeed1mi,
      "compets 1mi": p.competitors1mi,
      "kids/slot": p.kidsPerSlot1mi,
      income: p.medianHhIncome,
      "new hsg": p.newHousingShare,
      "mi from home": p.homeMiles,
    };
  })
);
