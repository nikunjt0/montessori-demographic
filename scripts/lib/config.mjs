// Shared configuration for the demographic pipeline.

export const STATE_FIPS = "17"; // Illinois

/** The suburban counties in scope: the collar counties plus Kendall (Oswego/Yorkville/Plano). */
export const COUNTIES = {
  "031": "Cook",
  "043": "DuPage",
  "089": "Kane",
  "093": "Kendall",
  "097": "Lake",
  "111": "McHenry",
  "197": "Will",
};

/** City of Chicago is excluded — this analysis is about the suburbs. */
export const EXCLUDE_PLACE_NAMES = ["Chicago"];

/** ACS 5-year vintages: current for levels, prior for 5-year growth deltas. */
export const ACS_YEAR = 2024;
export const ACS_PRIOR_YEAR = 2019;

/** Home base for distance rings and the optional commute penalty. */
export const HOME_BASE = { zip: "60502", label: "Aurora (60502)", lonLat: [-88.2565, 41.7833] };

/**
 * Catchment radii in miles. 1 mile is what parents actually treat as "our
 * school" and dominates the score; 3 miles is context and a tiebreaker.
 */
export const RADII = { primary: 1, secondary: 3 };

/** Bounding box covering all six counties, used for the Overpass query. */
export const REGION_BBOX = { south: 41.17, west: -88.78, north: 42.51, east: -87.50 };

export const PATHS = {
  raw: "data/raw",
  geometry: "data/geometry.json",
  census: "data/census.json",
  supply: "data/supply.json",
  dcfs: "data/dcfs.json",
  overrides: "data/competitor-overrides.csv",
  outBlockGroups: "public/data/blockgroups.json",
  outScores: "public/data/scores.json",
  outSupply: "public/data/supply.json",
  outMeta: "public/data/meta.json",
};
