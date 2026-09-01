// GET /api/locate?q=<address>
//
// Geocodes an address with the free Census geocoder (proxied server-side, so
// the browser needs no CORS or key) and returns the block group containing it.
// The client owns the scores, so only the geoid needs to travel back.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pointInGeometry, bboxOf } from "@/app/lib/pip";

const GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

interface BgFeature {
  properties: { geoid: string; place: string | null; county: string };
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  bbox: [number, number, number, number];
}

/** Loaded once per server process; ~1.8 MB parsed at first request. */
let blockGroups: BgFeature[] | null = null;

function loadBlockGroups(): BgFeature[] {
  if (blockGroups) return blockGroups;
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "public/data/blockgroups.json"), "utf8")
  ) as GeoJSON.FeatureCollection;
  blockGroups = raw.features.map((f) => ({
    properties: f.properties as BgFeature["properties"],
    geometry: f.geometry as BgFeature["geometry"],
    bbox: bboxOf(f.geometry as BgFeature["geometry"]),
  }));
  return blockGroups;
}

function findBlockGroup(lon: number, lat: number): BgFeature | null {
  for (const f of loadBlockGroups()) {
    const [minX, minY, maxX, maxY] = f.bbox;
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    if (pointInGeometry([lon, lat], f.geometry)) return f;
  }
  return null;
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams.get("q")?.trim();
  if (!q || q.length < 4) {
    return Response.json({ error: "Enter an address to search." }, { status: 400 });
  }

  // The Census geocoder matches best with a state hint; most searches here
  // will be bare street + town.
  const address = /\bIL\b|Illinois/i.test(q) ? q : `${q}, IL`;
  const url = `${GEOCODER}?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;

  let match: { matchedAddress: string; coordinates: { x: number; y: number } } | undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
    const json = await res.json();
    match = json?.result?.addressMatches?.[0];
  } catch (err) {
    console.error("[locate] geocoder failed:", err);
    return Response.json(
      { error: "The Census geocoder did not respond — try again in a moment." },
      { status: 502 }
    );
  }

  if (!match) {
    return Response.json(
      { error: "No match for that address. Try adding the town or ZIP." },
      { status: 404 }
    );
  }

  const lon = match.coordinates.x;
  const lat = match.coordinates.y;
  const bg = findBlockGroup(lon, lat);

  if (!bg) {
    return Response.json(
      {
        error: "That address geocodes outside the analysis area (suburban Cook, DuPage, Kane, Kendall, Lake, McHenry, Will).",
        matchedAddress: match.matchedAddress,
        lon, lat,
      },
      { status: 422 }
    );
  }

  return Response.json({
    matchedAddress: match.matchedAddress,
    lon, lat,
    geoid: bg.properties.geoid,
    place: bg.properties.place,
    county: bg.properties.county,
  });
}
