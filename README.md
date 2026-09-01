# Montessori / Daycare Site Finder — Chicago Suburbs

An interactive choropleth that scores every census **block group** in the
suburban counties (suburban Cook, DuPage, Kane, Kendall, Lake, McHenry, Will) for how good
a location it is to open an infant–6yo Montessori or daycare.

The City of Chicago is excluded — this is a suburban analysis.

## Quick start

```bash
npm install
cp .env.example .env          # then paste in your free Census API key
npm run data                  # fetch + build (~5-10 min, mostly Overpass)
npm run dev                   # http://localhost:3000
```

A free Census API key takes about 30 seconds to get:
<https://api.census.gov/data/key_signup.html>

## What the map shows

Each block group (roughly a neighborhood — 600–3,000 people) is shaded on a
single blue ramp: **darker = stronger opportunity**. Orange dots are existing
childcare providers, sized by estimated licensed capacity; Montessori schools
carry a ring so they are identifiable without relying on color. Dashed rings
mark 1 / 3 / 10 miles from the home base in `scripts/lib/config.mjs`.

Hover for a summary, click for the full breakdown, and drag the weight sliders
to re-score the entire map live.

Every block group carries its **locality name** (city/village, or township when
unincorporated) and **centroid coordinates** with a Google Maps link, so a spot
on the map translates directly into a real-estate search. The **address bar** on
the map ("Score an address…") geocodes any address via the free Census geocoder
(`/api/locate`, proxied server-side) and jumps to the exact block group
containing it, pinning the address and opening its full score breakdown.

## Why 1 mile

The primary catchment is **1 mile**; 3 miles is a secondary ring. Parents
choosing infant-through-preschool care optimize hard for proximity, and
enrollment willingness falls off sharply past about a mile. So both demand and
competitor supply are aggregated at 1 mile (weighted dominantly) and at 3 miles
(as a tiebreaker, and to catch areas that look empty at 1 mile only because they
sit beside a saturated neighbor).

## The score

Eight factors, each converted to a **percentile rank (0–100) across the region**,
then combined as a weighted average. Percentile ranking means every factor
contributes on the same scale regardless of its natural units.

| Factor | What it measures | Default weight |
|---|---|---|
| Working-parent demand | Children <6 within 1 mi whose available parents are **all** in the labor force (ACS B23008) — the households that structurally must buy care | 22% |
| Supply gap (1 mi) | Those children per licensed childcare slot within 1 mi. High = underserved | 20% |
| Young-child density | Children 0–4 within 1 mi — raw market size | 15% |
| New construction | Share of housing built since 2010, blended with population change since the 2020 census | 14% |
| Income fit | Match to mid-market Montessori tuition | 12% |
| Supply gap (3 mi) | Same ratio at 3 miles | 7% |
| Parent education | Share of adults 25+ with a bachelor's or higher | 5% |
| Family households | Households with children <18, plus owner-occupancy | 5% |

**Income is deliberately not monotonic.** Below ~$70k, full-freight tuition is
out of reach for most households; above ~$220k, families increasingly hire
nannies or choose established private schools. The curve peaks on a
$115k–$165k plateau (`incomeCurve` in `scripts/lib/scoring.mjs`).

**Competitors are weighted by how directly they compete**: Montessori and day
care centers 1.0, group day care homes 0.8, licensed in-home day care 0.55.
Licensed capacity is further scaled by how much of the 0–6 band each licence
covers, so a 3-to-5 preschool counts for roughly a third of what a
6-week-to-6-year centre does.

K-12 schools carry weight 0. They are counted and shown as neighborhood context,
but an elementary school is not childcare capacity, and a good one is a reason
families move in rather than a reason to stay away.

A `kidsPerSlot` ratio adds a smoothing constant so a block group with no nearby
capacity does not divide by zero and dominate the ranking on a technicality.

Four presets — Balanced, Underserved first, New construction, Premium tuition —
re-weight the factors for different strategies.

## Data sources

| Layer | Source | Notes |
|---|---|---|
| Boundaries | Census TIGER/Line cartographic block groups, 2024 | Simplified to ~20m tolerance |
| Demographics | ACS 2024 5-year, block group | 30 variables |
| Growth baseline | 2020 Decennial Census (DHC) | Same 2020 boundaries as ACS 2024, so the delta is valid |
| Childcare supply | **Illinois DCFS licensed provider list** | 3,487 licensed facilities in the seven counties, with real licensed capacity, age range served, and licence status |
| Schools | OpenStreetMap via Overpass | ~3,270 K-12 schools, shown as context |

The 2019 ACS is deliberately **not** used as the growth baseline: block groups
were redrawn for the 2020 census, so a 2019-vs-2024 comparison would be
measuring different shapes.

## MapLibre worker note

maplibre-gl v6 is ESM-only and resolves its web worker relative to the bundled
module URL. Under Next.js/Turbopack that request 404s, the worker never starts,
and the map stays silently blank — no GeoJSON, no basemap tiles, no error
event. `scripts/copy-worker.mjs` (wired into `predev`/`prebuild`) copies the
worker and its shared chunk into `public/vendor/maplibre/`, and the app calls
`setWorkerUrl()` before constructing the map. If you upgrade maplibre-gl, the
copies refresh automatically on the next dev/build.

## Pipeline

```
scripts/download-raw.sh     # TIGER shapefiles
scripts/fetch-geometry.mjs  # -> data/geometry.json     (simplified boundaries)
scripts/fetch-census.mjs    # -> data/census.json       (ACS + decennial)
scripts/fetch-dcfs.mjs      # -> data/dcfs.json         (DCFS licensed providers, geocoded)
scripts/fetch-supply.mjs    # -> data/supply.json       (OSM schools, tile-cached)
scripts/build.mjs           # -> public/data/*.json     (join + score)
```

Each step is independent and re-runnable. Overpass tiles are cached in
`data/raw/overpass/`, so a failed run resumes rather than restarting.

## Correcting the competitor list

The DCFS list is authoritative for licensed facilities but lags recent openings
and closures, and excludes license-exempt programs. Add local knowledge in
`data/competitor-overrides.csv`:

```csv
action,name,kind,lat,lon,capacity
add,Bright Beginnings Aurora,center,41.7812,-88.2501,90
remove,Closed Kids Academy,,,,
```

`kind` is one of `montessori`, `center`, `group_home`, `home`.

Then re-run `node scripts/build.mjs`. This is worth doing before trusting any
specific block group — drive the top candidates and check what is actually there.

## Known limitations

- **Unlicensed and informal care is invisible.** DCFS covers licensed providers;
  license-exempt programs (many park-district and church preschools) and
  informal family care are not counted, so the supply gap is somewhat
  overstated where those are common.
- **Capacity is licensed capacity, not enrollment.** A center licensed for 100
  may be running 60 or may have a waitlist. Slots are scaled by how much of the
  0-6 age band each license covers, which is an approximation — capacity is not
  actually spread evenly across ages.
- **Providers are geocoded, not verified.** 95% resolve to an exact street
  address; the remaining 5% fall back to a ZIP centroid and are flagged
  `precision: "zip"` in the data.
- **ACS margins of error are wide at block-group level.** Treat a single block
  group as a hint and the surrounding cluster as the real signal.
- **Median income is imputed** for ~9% of block groups where the Census
  suppresses it; those are flagged in the detail panel.
- Scores rank block groups **against each other**, not against an absolute
  standard. A 95 means "top 5% of the suburbs," not "guaranteed viable."
- This models demand and competition only — not zoning, commercial rents,
  build-out cost, or DCFS licensing feasibility for a specific parcel.
