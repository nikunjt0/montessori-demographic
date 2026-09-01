// Geometry helpers shared by the data pipeline.
// All coordinates are [lon, lat] in WGS84, matching GeoJSON order.

const R_MILES = 3958.7613;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in miles between two [lon,lat] points. */
export function haversineMiles([lon1, lat1], [lon2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.sqrt(a));
}

/** Rings of a Polygon/MultiPolygon, flattened to a single array of rings. */
function ringsOf(geom) {
  if (!geom) return [];
  if (geom.type === "Polygon") return geom.coordinates;
  if (geom.type === "MultiPolygon") return geom.coordinates.flat();
  return [];
}

/**
 * Area-weighted centroid of a Polygon/MultiPolygon, using only the outer ring
 * of each part. Falls back to the vertex mean for degenerate (zero-area) rings.
 */
export function centroid(geom) {
  const parts =
    geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
  let cx = 0, cy = 0, area2 = 0;
  for (const part of parts) {
    const ring = part[0];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j];
      const [x1, y1] = ring[i];
      const cross = x0 * y1 - x1 * y0;
      area2 += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
  }
  if (Math.abs(area2) < 1e-12) {
    const pts = ringsOf(geom).flat();
    if (!pts.length) return [0, 0];
    return [
      pts.reduce((s, p) => s + p[0], 0) / pts.length,
      pts.reduce((s, p) => s + p[1], 0) / pts.length,
    ];
  }
  return [cx / (3 * area2), cy / (3 * area2)];
}

/** [minLon, minLat, maxLon, maxLat] of any Polygon/MultiPolygon. */
export function bbox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ringsOf(geom).flat()) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** Ray-casting test of a [lon,lat] point against one ring. */
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Point-in-polygon for Polygon/MultiPolygon, honouring interior rings (holes). */
export function pointInGeometry(pt, geom) {
  const parts =
    geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
  for (const part of parts) {
    if (!inRing(pt, part[0])) continue;
    // Inside the outer ring — reject if it falls in a hole.
    if (part.slice(1).some((hole) => inRing(pt, hole))) continue;
    return true;
  }
  return false;
}

/** Perpendicular distance from p to the segment a-b, in degree units. */
function segDist(p, a, b) {
  let [x, y] = a;
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) [x, y] = b;
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  return Math.hypot(p[0] - x, p[1] - y);
}

/** Douglas-Peucker on an open point list. */
function dp(points, tol) {
  if (points.length < 3) return points;
  let maxD = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = segDist(points[i], points[0], points[points.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [points[0], points[points.length - 1]];
  return [
    ...dp(points.slice(0, idx + 1), tol).slice(0, -1),
    ...dp(points.slice(idx), tol),
  ];
}

/**
 * Simplify a Polygon/MultiPolygon and round coordinates.
 * Rings that collapse below 4 points are dropped; parts that lose their outer
 * ring are dropped entirely. Returns null if nothing survives.
 */
export function simplifyGeometry(geom, tol = 0.0002, precision = 5) {
  const f = 10 ** precision;
  const round = ([x, y]) => [Math.round(x * f) / f, Math.round(y * f) / f];

  const doRing = (ring) => {
    // Simplify as an open line, then re-close, so the closing point is kept.
    const open = ring.slice(0, -1);
    let out = dp(open, tol).map(round);
    // Drop consecutive duplicates introduced by rounding.
    out = out.filter((p, i) => i === 0 || p[0] !== out[i - 1][0] || p[1] !== out[i - 1][1]);
    if (out.length < 3) return null;
    return [...out, out[0]];
  };

  const doPart = (part) => {
    const outer = doRing(part[0]);
    if (!outer) return null;
    const holes = part.slice(1).map(doRing).filter(Boolean);
    return [outer, ...holes];
  };

  if (geom.type === "Polygon") {
    const part = doPart(geom.coordinates);
    return part ? { type: "Polygon", coordinates: part } : null;
  }
  const parts = geom.coordinates.map(doPart).filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1
    ? { type: "Polygon", coordinates: parts[0] }
    : { type: "MultiPolygon", coordinates: parts };
}

/** Square-degree box around a point that safely contains a radius in miles. */
export function degBox([lon, lat], miles) {
  const dLat = miles / 69.0;
  const dLon = miles / (69.0 * Math.max(0.01, Math.cos(toRad(lat))));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/**
 * Uniform lat/lon grid index for radius queries. Naive O(n*m) scans over ~3,800
 * block groups x ~3,800 facilities are survivable but wasteful; this keeps the
 * whole build under a second.
 */
export class GridIndex {
  constructor(items, cellDeg = 0.02) {
    this.cell = cellDeg;
    this.buckets = new Map();
    for (const item of items) {
      const key = this.#key(item.lon, item.lat);
      let bucket = this.buckets.get(key);
      if (!bucket) this.buckets.set(key, (bucket = []));
      bucket.push(item);
    }
  }

  #key(lon, lat) {
    return `${Math.floor(lon / this.cell)}:${Math.floor(lat / this.cell)}`;
  }

  /** Every indexed item whose point lies within `miles` of [lon,lat]. */
  within(lonLat, miles) {
    const [minX, minY, maxX, maxY] = degBox(lonLat, miles);
    const out = [];
    for (let cx = Math.floor(minX / this.cell); cx <= Math.floor(maxX / this.cell); cx++) {
      for (let cy = Math.floor(minY / this.cell); cy <= Math.floor(maxY / this.cell); cy++) {
        const bucket = this.buckets.get(`${cx}:${cy}`);
        if (!bucket) continue;
        for (const item of bucket) {
          if (haversineMiles(lonLat, [item.lon, item.lat]) <= miles) out.push(item);
        }
      }
    }
    return out;
  }
}
