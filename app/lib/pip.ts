// Point-in-polygon for GeoJSON Polygon / MultiPolygon.
// Mirror of the pipeline's scripts/lib/geo.mjs, typed for app code.

type Ring = number[][];

function inRing([x, y]: [number, number], ring: Ring): boolean {
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

/** Honours interior rings (holes). */
export function pointInGeometry(
  pt: [number, number],
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon
): boolean {
  const parts = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
  for (const part of parts) {
    if (!inRing(pt, part[0] as Ring)) continue;
    if (part.slice(1).some((hole) => inRing(pt, hole as Ring))) continue;
    return true;
  }
  return false;
}

export function bboxOf(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rings = geom.type === "MultiPolygon" ? geom.coordinates.flat() : geom.coordinates;
  for (const [x, y] of rings.flat() as unknown as [number, number][]) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
