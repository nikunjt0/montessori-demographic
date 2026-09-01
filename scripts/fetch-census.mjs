// Step 2: pull ACS 5-year + 2020 Decennial data per block group.
//
//   node scripts/fetch-census.mjs
//
// Needs CENSUS_DATA_API_KEY in .env (free: https://api.census.gov/data/key_signup.html).
// Writes data/census.json keyed by 12-digit GEOID.

import { writeFileSync } from "node:fs";
import { STATE_FIPS, COUNTIES, ACS_YEAR, PATHS } from "./lib/config.mjs";
import { ACS_VARS, DEC_VARS } from "./lib/variables.mjs";

process.loadEnvFile(".env");
const KEY = process.env.CENSUS_DATA_API_KEY;
if (!KEY) {
  console.error("Missing CENSUS_DATA_API_KEY in .env — get one free at https://api.census.gov/data/key_signup.html");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Census sentinel values for "not available" (median income in an empty block
 * group, etc.). Anything at or below -666666666 is a sentinel, not data.
 */
function clean(raw) {
  if (raw === null || raw === "" || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= -666666666) return null;
  return n;
}

/** Fetch JSON with retries — the API intermittently 500s / returns an HTML error page. */
async function getJson(url, label, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (res.status === 200) return JSON.parse(text);
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
    } catch (err) {
      if (i === attempts) throw new Error(`${label} failed after ${attempts} tries — ${err.message}`);
      const backoff = 800 * i;
      console.warn(`  retry ${i}/${attempts - 1} for ${label} in ${backoff}ms (${err.message.slice(0, 70)})`);
      await sleep(backoff);
    }
  }
}

/** Turn a Census 2-D array response into rows keyed by GEOID. */
function toRows(json, nameMap) {
  const [header, ...body] = json;
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out = new Map();
  for (const row of body) {
    // GEOID = state(2) + county(3) + tract(6) + block group(1)
    const geoid = row[idx.state] + row[idx.county] + row[idx.tract] + row[idx["block group"]];
    const rec = {};
    for (const [name, code] of Object.entries(nameMap)) rec[name] = clean(row[idx[code]]);
    out.set(geoid, rec);
  }
  return out;
}

const GEO = `&for=block%20group:*&in=state:${STATE_FIPS}%20county:__CTY__%20tract:*`;
const merged = {};

for (const [fips, name] of Object.entries(COUNTIES)) {
  const geo = GEO.replace("__CTY__", fips);

  const acsUrl = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5?get=${Object.values(ACS_VARS).join(",")}${geo}&key=${KEY}`;
  const acs = toRows(await getJson(acsUrl, `ACS ${name}`), ACS_VARS);
  await sleep(500);

  const decUrl = `https://api.census.gov/data/2020/dec/dhc?get=${Object.values(DEC_VARS).join(",")}${geo}&key=${KEY}`;
  const dec = toRows(await getJson(decUrl, `DHC ${name}`), DEC_VARS);
  await sleep(500);

  for (const [geoid, rec] of acs) merged[geoid] = { ...rec, ...(dec.get(geoid) ?? {}) };
  console.log(`${name.padEnd(8)} ACS ${String(acs.size).padStart(5)} block groups | DHC ${String(dec.size).padStart(5)}`);
}

writeFileSync(PATHS.census, JSON.stringify(merged));

const all = Object.values(merged);
const missing = (k) => all.filter((r) => r[k] === null).length;
console.log(`\nWrote ${PATHS.census} — ${all.length} block groups.`);
console.log(`Null rates: medianHhIncome ${missing("medianHhIncome")}, kidsUnder6BothParentsLF ${missing("kidsUnder6BothParentsLF")}, pop2020 ${missing("pop2020")}`);
