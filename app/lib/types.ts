// Shapes of the static data files emitted by scripts/build.mjs.

export type FactorKey =
  | "careNeed" | "kidDensity" | "supplyGap" | "supplyGap3"
  | "growth" | "income" | "education" | "families";

export interface Factor {
  key: FactorKey;
  label: string;
  help: string;
}

export type Weights = Record<FactorKey, number>;

export interface Meta {
  generatedAt: string;
  acsYear: number;
  counties: string[];
  radii: { primary: number; secondary: number };
  homeBase: { zip: string; label: string; lonLat: [number, number] };
  blockGroups: number;
  facilities: number;
  factors: Factor[];
  defaultWeights: Weights;
  competitorWeight: Record<string, number>;
}

/** Every property carried on a block-group feature. */
export interface BlockGroupProps extends Partial<Record<FactorKey, number | null>> {
  geoid: string;
  county: string;
  /** City/village name, or "<township> (unincorp.)" outside incorporated places. */
  place: string | null;
  /** Block-group centroid, for coordinates display and map links. */
  lon: number;
  lat: number;
  score: number | null;
  /** [minLon, minLat, maxLon, maxLat] — used to zoom to the block group. */
  bbox?: [number, number, number, number];
  pop: number | null;
  medianHhIncome: number | null;
  incomeImputed: boolean;
  medianHomeValue: number | null;
  kids0to4: number;
  kids5to9: number;
  careNeed: number | null;
  kids0to4_1mi: number;
  kids5to9_1mi: number;
  careNeed1mi: number;
  careNeed3mi: number;
  slots1mi: number;
  slots3mi: number;
  competitors1mi: number;
  centers1mi: number;
  homes1mi: number;
  competitors3mi: number;
  montessori1mi: number;
  schools1mi: number;
  kidsPerSlot1mi: number;
  kidsPerSlot3mi: number;
  newHousingShare: number | null;
  popGrowth: number | null;
  ownerShare: number | null;
  eduShare: number | null;
  kidsHhShare: number | null;
  povertyRate: number | null;
  homeMiles: number;
}

/**
 * DCFS facility types: `center` = day care center (DCC), `group_home` = group
 * day care home (GDC), `home` = licensed in-home day care (DCH).
 * `school` comes from OpenStreetMap and is context only.
 */
export type FacilityKind = "montessori" | "center" | "group_home" | "home" | "school";

export interface Facility {
  id?: string;
  osmId?: string;
  name: string;
  kind: FacilityKind;
  lon: number;
  lat: number;
  /** Licensed day capacity (DCFS), or an estimate for OSM-sourced records. */
  capacity: number;
  /** Share of the 0-6 band this licence covers. */
  ageFactor?: number;
  ageRange?: string;
  status?: string;
  city: string | null;
  street: string | null;
  /** "address" when geocoded exactly, "zip" when only the ZIP centroid was available. */
  precision?: "address" | "zip";
  source: "dcfs" | "osm" | "manual";
}

/**
 * Weighted composite of per-factor percentile scores. Mirrors `composite()` in
 * scripts/lib/scoring.mjs: missing factors drop out and the remaining weights
 * renormalise, so a block group is never penalised for a gap in source data.
 */
export function composite(
  props: Partial<Record<FactorKey, number | null>>,
  weights: Weights,
  factors: Factor[]
): number | null {
  let sum = 0;
  let used = 0;
  for (const { key } of factors) {
    const s = props[key];
    const w = weights[key] ?? 0;
    if (s === null || s === undefined || w === 0) continue;
    sum += s * w;
    used += w;
  }
  return used === 0 ? null : sum / used;
}

/** Score-weighting presets for different business strategies. */
export const PRESETS: Record<string, { label: string; blurb: string; weights: Weights }> = {
  balanced: {
    label: "Balanced",
    blurb: "Mid-market Montessori + daycare. The default.",
    weights: { careNeed: 0.22, kidDensity: 0.15, supplyGap: 0.20, supplyGap3: 0.07, growth: 0.14, income: 0.12, education: 0.05, families: 0.05 },
  },
  underserved: {
    label: "Underserved first",
    blurb: "Chase the widest supply gaps, even in less affluent areas.",
    weights: { careNeed: 0.20, kidDensity: 0.10, supplyGap: 0.34, supplyGap3: 0.14, growth: 0.10, income: 0.06, education: 0.03, families: 0.03 },
  },
  growth: {
    label: "New construction",
    blurb: "Follow the subdivisions — bet on families arriving next.",
    weights: { careNeed: 0.14, kidDensity: 0.11, supplyGap: 0.15, supplyGap3: 0.05, growth: 0.35, income: 0.10, education: 0.05, families: 0.05 },
  },
  premium: {
    label: "Premium tuition",
    blurb: "Affluent, highly-educated households that pay full freight.",
    weights: { careNeed: 0.18, kidDensity: 0.12, supplyGap: 0.14, supplyGap3: 0.04, growth: 0.10, income: 0.24, education: 0.14, families: 0.04 },
  },
};
