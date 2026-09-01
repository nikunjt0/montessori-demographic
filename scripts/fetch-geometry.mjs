// Step 1: turn the TIGER block-group shapefile into simplified GeoJSON for the
// six collar counties, minus the City of Chicago.
//
//   node scripts/fetch-geometry.mjs
//
// Reads data/raw/cb_*_bg_500k.shp and cb_*_place_500k.shp, writes data/geometry.json.

import { open } from "shapefile";
import { writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { COUNTIES, EXCLUDE_PLACE_NAMES, PATHS } from "./lib/config.mjs";
import { centroid, simplifyGeometry, pointInGeometry, bbox } from "./lib/geo.mjs";

function findShp(pattern) {
  const hit = readdirSync(PATHS.raw).find((f) => f.includes(pattern) && f.endsWith(".shp"));
  if (!hit) throw new Error(`No shapefile matching "${pattern}" in ${PATHS.raw}. Run scripts/download-raw.sh first.`);
  return join(PATHS.raw, hit);
}

async function readAll(shpPath) {
  const src = await open(shpPath);
  const out = [];
  for (let r = await src.read(); !r.done; r = await src.read()) out.push(r.value);
  return out;
}

const allPlaces = await readAll(findShp("_place_"));
const excluded = allPlaces.filter((p) => EXCLUDE_PLACE_NAMES.includes(p.properties.NAME));
console.log(`Excluding ${excluded.length} place polygon(s): ${excluded.map((p) => p.properties.NAME).join(", ")}`);
const excludedBoxes = excluded.map((p) => bbox(p.geometry));

/**
 * Every block group gets a human-readable locality: the incorporated place
 * (city/village) its centroid falls in, or the county subdivision (township)
 * when unincorporated. Both are matched by centroid point-in-polygon, with a
 * bbox pre-check so the loop stays fast.
 */
const placeIndex = allPlaces.map((p) => ({ name: p.properties.NAME, box: bbox(p.geometry), geom: p.geometry }));
const cousubIndex = (await readAll(findShp("_cousub_"))).map((p) => ({
  name: p.properties.NAMELSAD, // e.g. "Wheatland township"
  box: bbox(p.geometry),
  geom: p.geometry,
}));

function localityOf(c) {
  const hit = (index) =>
    index.find(({ box: [minX, minY, maxX, maxY], geom }) =>
      c[0] >= minX && c[0] <= maxX && c[1] >= minY && c[1] <= maxY && pointInGeometry(c, geom)
    );
  const place = hit(placeIndex);
  if (place) return place.name;
  const twp = hit(cousubIndex);
  return twp ? `${twp.name} (unincorp.)` : null;
}

const features = [];
let seen = 0, droppedChicago = 0, droppedEmpty = 0;

for (const f of await readAll(findShp("_bg_"))) {
  const p = f.properties;
  if (!COUNTIES[p.COUNTYFP]) continue;
  seen++;

  const c = centroid(f.geometry);

  // Drop block groups whose centroid falls inside an excluded place.
  const inExcluded = excluded.some((place, i) => {
    const [minX, minY, maxX, maxY] = excludedBoxes[i];
    if (c[0] < minX || c[0] > maxX || c[1] < minY || c[1] > maxY) return false;
    return pointInGeometry(c, place.geometry);
  });
  if (inExcluded) { droppedChicago++; continue; }

  const geom = simplifyGeometry(f.geometry);
  if (!geom) { droppedEmpty++; continue; }

  const place = localityOf(c);

  features.push({
    type: "Feature",
    // GEOID is the 12-digit block group id; it is the join key for ACS data.
    id: p.GEOID,
    properties: {
      geoid: p.GEOID,
      county: COUNTIES[p.COUNTYFP],
      place,
      countyFp: p.COUNTYFP,
      tract: p.TRACTCE,
      bg: p.BLKGRPCE,
      // ALAND is in square metres; convert to square miles for density math.
      landSqMi: +(p.ALAND / 2_589_988).toFixed(4),
      lon: +c[0].toFixed(5),
      lat: +c[1].toFixed(5),
    },
    geometry: geom,
  });
}

const out = { type: "FeatureCollection", features };
writeFileSync(PATHS.geometry, JSON.stringify(out));

const byCounty = {};
for (const f of features) byCounty[f.properties.county] = (byCounty[f.properties.county] ?? 0) + 1;

console.log(`\nBlock groups in the 6 counties: ${seen}`);
console.log(`  dropped (inside Chicago): ${droppedChicago}`);
console.log(`  dropped (empty geometry): ${droppedEmpty}`);
console.log(`  kept: ${features.length}`);
console.table(byCounty);
const noPlace = features.filter((f) => !f.properties.place).length;
const samplePlaces = [...new Set(features.map((f) => f.properties.place))].slice(0, 12);
console.log(`Locality assigned; ${noPlace} block groups with no match.`);
console.log("Sample localities:", samplePlaces.join(" | "));
console.log(`Wrote ${PATHS.geometry} (${(JSON.stringify(out).length / 1e6).toFixed(1)} MB)`);
