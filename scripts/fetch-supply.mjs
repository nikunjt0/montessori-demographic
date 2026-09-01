// Step 3: pull existing childcare / preschool / school locations from
// OpenStreetMap via Overpass, classify them, and de-duplicate.
//
//   node scripts/fetch-supply.mjs
//
// Writes data/supply.json. Hand corrections live in data/competitor-overrides.csv
// and are applied later, in build.mjs.

import { writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REGION_BBOX, PATHS } from "./lib/config.mjs";
import { haversineMiles } from "./lib/geo.mjs";

const { south, west, north, east } = REGION_BBOX;

/**
 * All selectors run as ONE union query, but over a TILED bounding box.
 *
 * Region-wide requests time out (HTTP 504) — `amenity=school` alone matches
 * ~2,800 ways across the six counties. Splitting geographically keeps every
 * request small, and each tile is cached so a failure part-way through does
 * not throw away the tiles that already succeeded.
 */
const SELECTORS = [
  'nwr["amenity"="childcare"]',
  'nwr["amenity"="kindergarten"]',
  'nwr["amenity"="preschool"]',
  'nwr["amenity"="school"]',
  'nwr["office"="childcare"]',
  'nwr["name"~"[Mm]ontessori"]',
];

const TILES = 4; // 4x4 grid over the region
const CACHE_DIR = join(PATHS.raw, "overpass");

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tileBoxes() {
  const boxes = [];
  const dLat = (north - south) / TILES;
  const dLon = (east - west) / TILES;
  for (let r = 0; r < TILES; r++) {
    for (let c = 0; c < TILES; c++) {
      boxes.push({
        id: `r${r}c${c}`,
        bb: [
          (south + r * dLat).toFixed(4),
          (west + c * dLon).toFixed(4),
          (south + (r + 1) * dLat).toFixed(4),
          (west + (c + 1) * dLon).toFixed(4),
        ].join(","),
      });
    }
  }
  return boxes;
}

async function fetchTile({ id, bb }) {
  const cacheFile = join(CACHE_DIR, `${id}.json`);
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8"));
    console.log(`  ${id}  ${String(cached.length).padStart(4)} elements  (cached)`);
    return cached;
  }

  const union = SELECTORS.map((sel) => `${sel}(${bb});`).join("");
  const query = `[out:json][timeout:180];(${union});out center tags;`;

  for (let attempt = 1; attempt <= 4; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        // Overpass rejects requests with no descriptive User-Agent (HTTP 406).
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "montessori-demographic/1.0 (site-selection research)",
          },
          body: new URLSearchParams({ data: query }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.elements) throw new Error("no elements field");
        writeFileSync(cacheFile, JSON.stringify(json.elements));
        console.log(`  ${id}  ${String(json.elements.length).padStart(4)} elements  (${new URL(url).host})`);
        return json.elements;
      } catch (err) {
        console.warn(`  ${id} via ${new URL(url).host}: ${err.message}`);
        await sleep(2000);
      }
    }
    const backoff = 5000 * attempt;
    console.warn(`  ${id} attempt ${attempt}/4 exhausted endpoints, waiting ${backoff}ms`);
    await sleep(backoff);
  }
  throw new Error(`Tile ${id} failed on every endpoint. Re-run to resume — completed tiles are cached in ${CACHE_DIR}.`);
}

async function runQuery() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const boxes = tileBoxes();
  console.log(`Fetching ${boxes.length} tiles from Overpass...`);
  const seen = new Map();
  for (const box of boxes) {
    for (const el of await fetchTile(box)) {
      seen.set(`${el.type}/${el.id}`, el); // tiles overlap at edges; dedupe by id
    }
    await sleep(1000); // be polite to a free public API
  }
  return [...seen.values()];
}

/**
 * Bucket a facility by how directly it competes for an infant-6yo Montessori.
 *   montessori  - same product, same parents. Strongest competitor.
 *   daycare     - infant/toddler care. Direct competitor.
 *   preschool   - 3-6yo programs, incl. OSM "kindergarten" (how US preschools
 *                 are usually tagged).
 *   school      - K-12. Not a direct competitor for infants, but it serves the
 *                 5-6yo end and signals how well-served an area already is.
 */
function classify(tags) {
  const name = (tags.name ?? "").toLowerCase();
  if (/montessori/.test(name)) return "montessori";
  if (tags.amenity === "childcare" || tags.office === "childcare") return "daycare";
  if (/(day\s?care|daycare|child\s?care|learning center|early learning|kindercare|goddard|primrose|bright horizons)/.test(name)) return "daycare";
  if (tags.amenity === "preschool" || tags.amenity === "kindergarten") return "preschool";
  if (/(preschool|pre-school|pre-k|nursery school)/.test(name)) return "preschool";
  if (tags.amenity === "school") return "school";
  return null;
}

/**
 * Licensed-capacity estimate. OSM rarely carries `capacity`, so fall back to
 * typical Illinois licensed capacities by facility type. Deliberately
 * conservative - the score uses capacity only for relative saturation.
 */
const DEFAULT_CAPACITY = { montessori: 90, daycare: 100, preschool: 60, school: 0 };

function capacityOf(tags, kind) {
  const raw = Number(tags.capacity ?? tags["capacity:persons"]);
  if (Number.isFinite(raw) && raw > 0 && raw < 2000) return raw;
  return DEFAULT_CAPACITY[kind];
}

const elements = await runQuery();
console.log(`Overpass returned ${elements.length} raw elements.`);

const candidates = [];
for (const el of elements) {
  const tags = el.tags ?? {};
  const kind = classify(tags);
  if (!kind) continue;

  const lon = el.lon ?? el.center?.lon;
  const lat = el.lat ?? el.center?.lat;
  if (lon === undefined || lat === undefined) continue;

  // Skip clearly-closed entries.
  if (tags.disused === "yes" || tags["disused:amenity"] || tags.abandoned === "yes") continue;

  candidates.push({
    osmId: `${el.type}/${el.id}`,
    name: tags.name ?? "(unnamed)",
    kind,
    lon: +lon.toFixed(5),
    lat: +lat.toFixed(5),
    capacity: capacityOf(tags, kind),
    operator: tags.operator ?? null,
    city: tags["addr:city"] ?? null,
    street: [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ") || null,
    source: "osm",
  });
}

/**
 * De-duplicate: OSM often maps one facility as both a node (the POI) and a way
 * (the building footprint). Treat same-name entries within 150m as one, and
 * keep the richer record.
 */
const DEDUPE_MILES = 0.093; // ~150 m
const kept = [];
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

for (const c of candidates.sort((a, b) => (b.street ? 1 : 0) - (a.street ? 1 : 0))) {
  const dup = kept.find(
    (k) =>
      norm(k.name) === norm(c.name) &&
      c.name !== "(unnamed)" &&
      haversineMiles([k.lon, k.lat], [c.lon, c.lat]) < DEDUPE_MILES
  );
  if (dup) continue;
  kept.push(c);
}

writeFileSync(PATHS.supply, JSON.stringify(kept));

const byKind = {};
for (const k of kept) byKind[k.kind] = (byKind[k.kind] ?? 0) + 1;
console.log(`\nKept ${kept.length} facilities after de-duplication (${candidates.length - kept.length} dupes removed).`);
console.table(byKind);

// Seed the hand-correction file so it is obvious how to add local knowledge.
if (!existsSync(PATHS.overrides)) {
  writeFileSync(
    PATHS.overrides,
    [
      "# Hand corrections to the OSM competitor list. Applied by scripts/build.mjs.",
      "# action: add | remove",
      "#   add    -> name,kind,lat,lon,capacity  (kind: montessori|daycare|preschool|school)",
      "#   remove -> match on name (case-insensitive substring) and, if given, within 0.5mi of lat/lon",
      "action,name,kind,lat,lon,capacity",
      "",
    ].join("\n")
  );
  console.log(`Seeded ${PATHS.overrides} for your local corrections.`);
}
