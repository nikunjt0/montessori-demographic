// Step 3b: pull the authoritative Illinois DCFS licensed day care provider list.
//
//   node scripts/fetch-dcfs.mjs
//
// OpenStreetMap maps childcare centers unevenly and misses licensed in-home
// providers almost entirely, which made empty map data look like real market
// gaps. DCFS publishes every licensed facility in the state, with licensed
// capacity, the age range served, and license status.
//
// The Sunshine site has no API — it is an ASP.NET WebForms page whose grid has
// a CSV "Export" submit button. Replaying that postback returns the whole
// statewide list. Addresses are then geocoded with the free Census batch
// geocoder. Writes data/dcfs.json.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { COUNTIES, PATHS } from "./lib/config.mjs";

const LOOKUP_URL =
  "https://sunshine.dcfs.illinois.gov/Content/Licensing/Daycare/ProviderLookup.aspx";
const GEOCODER =
  "https://geocoding.geo.census.gov/geocoder/locations/addressbatch";
const RAW_CSV = join(PATHS.raw, "dcfs-providers.csv");
const GEO_CACHE = join(PATHS.raw, "geocode");

const TARGET_COUNTIES = new Set(Object.values(COUNTIES).map((c) => c.toUpperCase()));

/** License states that mean "operating today". */
const ACTIVE_STATUS = /^(License issued|Pending renewal|Permit issued|Pending address change|Amended permit)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. Replay the WebForms export postback
// ---------------------------------------------------------------------------
async function downloadCsv() {
  if (existsSync(RAW_CSV)) {
    console.log(`Using cached ${RAW_CSV}`);
    return readFileSync(RAW_CSV, "utf8");
  }

  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
  const page = await fetch(LOOKUP_URL, { headers: { "User-Agent": ua } });
  const html = await page.text();
  const cookies = (page.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");

  const hidden = (name) => {
    const re = new RegExp(`(?:id|name)="${name.replace(/\$/g, "\\$")}"[^>]*value="([^"]*)"`);
    return html.match(re)?.[1] ?? "";
  };

  const body = new URLSearchParams({
    __VIEWSTATE: hidden("__VIEWSTATE"),
    __VIEWSTATEGENERATOR: hidden("__VIEWSTATEGENERATOR"),
    __VIEWSTATEENCRYPTED: hidden("__VIEWSTATEENCRYPTED"),
    __EVENTVALIDATION: hidden("__EVENTVALIDATION"),
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    "ctl00$ASPxHiddenFieldSite": hidden("ctl00\\$ASPxHiddenFieldSite"),
    "ctl00$ContentPlaceHolderContent$ASPxProviderName": "",
    "ctl00$ContentPlaceHolderContent$ASPxCity": "",
    "ctl00$ContentPlaceHolderContent$ASPxCounty": "",
    "ctl00$ContentPlaceHolderContent$ASPxZip": "",
    // The export ignores the filter fields and returns the full state list.
    "ctl00$ContentPlaceHolderContent$ASPxButtonExport": "Export",
  });

  const res = await fetch(LOOKUP_URL, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: LOOKUP_URL,
      Cookie: cookies,
    },
    body,
  });
  if (!res.ok) throw new Error(`DCFS export failed: HTTP ${res.status}`);
  const csv = await res.text();
  if (!csv.startsWith("ProviderID")) {
    throw new Error("DCFS export did not return the expected CSV header — the form may have changed.");
  }
  mkdirSync(PATHS.raw, { recursive: true });
  writeFileSync(RAW_CSV, csv);
  console.log(`Downloaded DCFS export (${(csv.length / 1e6).toFixed(2)} MB)`);
  return csv;
}

// ---------------------------------------------------------------------------
// 2. Parse
// ---------------------------------------------------------------------------
/** Minimal RFC4180 CSV parser — fields may be quoted and contain commas. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i]?.trim() ?? ""])));
}

/** "6W TO 12Y" / "15M TO 12Y" / "0 TO 12Y" -> [minYears, maxYears]. */
function parseAgeRange(raw) {
  const m = raw?.toUpperCase().match(/([\d.]+)\s*([WMY])?\s*TO\s*([\d.]+)\s*([WMY])?/);
  if (!m) return null;
  const toYears = (n, unit) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    if (unit === "W") return v / 52;
    if (unit === "M") return v / 12;
    return v; // Y, or bare 0
  };
  const lo = toYears(m[1], m[2]);
  const hi = toYears(m[3], m[4]);
  return lo === null || hi === null || hi <= lo ? null : [lo, hi];
}

/**
 * Fraction of the 0-6 year band a licence covers. A 6-week-to-12-year centre
 * covers essentially all of it; a 3-to-5 preschool covers a third. Capacity is
 * scaled by this so an elementary-age-only program does not count as infant
 * competition.
 */
function ageFactor(raw) {
  const range = parseAgeRange(raw);
  if (!range) return { factor: 0.85, known: false }; // broad default, flagged
  const [lo, hi] = range;
  const overlap = Math.max(0, Math.min(hi, 6) - Math.max(lo, 0));
  return { factor: +(overlap / 6).toFixed(3), known: true };
}

const KIND_BY_TYPE = { DCC: "center", GDC: "group_home", DCH: "home" };

const csv = await downloadCsv();
const all = parseCsv(csv);
console.log(`Parsed ${all.length} statewide records.`);

let droppedStatus = 0, droppedAge = 0;
const providers = [];
for (const r of all) {
  if (!TARGET_COUNTIES.has(r.County.toUpperCase())) continue;
  if (!ACTIVE_STATUS.test(r.Status)) { droppedStatus++; continue; }

  const { factor, known } = ageFactor(r.DayAgeRange);
  if (factor <= 0) { droppedAge++; continue; } // school-age only

  const capacity = Number(r.DayCapacity) || 0;
  if (capacity <= 0) continue;

  const name = r.DoingBusinessAs.trim();
  providers.push({
    id: r.ProviderID,
    name,
    kind: /MONTESSORI/i.test(name) ? "montessori" : KIND_BY_TYPE[r.FacilityType] ?? "center",
    facilityType: r.FacilityType,
    capacity,
    ageRange: r.DayAgeRange.trim(),
    ageFactor: factor,
    ageKnown: known,
    street: r.Street.trim(),
    city: r.City.trim(),
    county: r.County.trim(),
    zip: r.Zip.trim().slice(0, 5),
    status: r.Status,
    source: "dcfs",
  });
}
console.log(
  `Kept ${providers.length} providers in the 6 counties ` +
  `(${droppedStatus} inactive licences, ${droppedAge} school-age-only).`
);

// ---------------------------------------------------------------------------
// 3. Geocode via the free Census batch geocoder
// ---------------------------------------------------------------------------
mkdirSync(GEO_CACHE, { recursive: true });
const CHUNK = 500;
const coords = new Map();

for (let start = 0; start < providers.length; start += CHUNK) {
  const batch = providers.slice(start, start + CHUNK);
  const cacheFile = join(GEO_CACHE, `dcfs-${start}.csv`);
  let out;

  if (existsSync(cacheFile)) {
    out = readFileSync(cacheFile, "utf8");
    console.log(`  batch ${start}-${start + batch.length} (cached)`);
  } else {
    const payload = batch
      .map((p) => [p.id, p.street, p.city, "IL", p.zip].map((v) => `"${String(v).replace(/"/g, "")}"`).join(","))
      .join("\n");

    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const form = new FormData();
        form.append("addressFile", new Blob([payload], { type: "text/csv" }), "addresses.csv");
        form.append("benchmark", "Public_AR_Current");
        const res = await fetch(GEOCODER, { method: "POST", body: form });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        out = await res.text();
        if (!out.includes(",")) throw new Error("empty geocoder response");
        writeFileSync(cacheFile, out);
        console.log(`  batch ${start}-${start + batch.length} geocoded`);
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`  batch ${start} attempt ${attempt}/4: ${err.message}`);
        await sleep(3000 * attempt);
      }
    }
    if (!out) throw new Error(`Geocoding failed at batch ${start}: ${lastErr?.message}`);
  }

  for (const row of parseCsv("id,input,match,type,matched,coord,tiger,side\n" + out)) {
    if (row.match !== "Match" || !row.coord) continue;
    const [lon, lat] = row.coord.split(",").map(Number);
    if (Number.isFinite(lon) && Number.isFinite(lat)) coords.set(row.id, [lon, lat]);
  }
  await sleep(500);
}

// Fall back to the mean of successfully geocoded providers in the same ZIP.
const byZip = new Map();
for (const p of providers) {
  const c = coords.get(p.id);
  if (!c) continue;
  if (!byZip.has(p.zip)) byZip.set(p.zip, []);
  byZip.get(p.zip).push(c);
}

let exact = 0, zipFallback = 0, unplaced = 0;
const located = [];
for (const p of providers) {
  let lonLat = coords.get(p.id);
  let precision = "address";
  if (!lonLat) {
    const peers = byZip.get(p.zip);
    if (peers?.length) {
      lonLat = [
        peers.reduce((s, c) => s + c[0], 0) / peers.length,
        peers.reduce((s, c) => s + c[1], 0) / peers.length,
      ];
      precision = "zip";
    }
  }
  if (!lonLat) { unplaced++; continue; }
  if (precision === "address") exact++;
  else zipFallback++;
  located.push({ ...p, lon: +lonLat[0].toFixed(5), lat: +lonLat[1].toFixed(5), precision });
}

writeFileSync(PATHS.dcfs, JSON.stringify(located));

const byKind = {};
for (const p of located) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
console.log(`\nGeocoded: ${exact} exact, ${zipFallback} ZIP-centroid fallback, ${unplaced} unplaced.`);
console.table(byKind);
console.log(`Total licensed day capacity (age-weighted): ${Math.round(located.reduce((s, p) => s + p.capacity * p.ageFactor, 0)).toLocaleString()}`);
console.log(`Wrote ${PATHS.dcfs}`);
