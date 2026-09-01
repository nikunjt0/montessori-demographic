"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  ExpressionSpecification,
  FilterSpecification,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  Popup as MapLibrePopup,
} from "maplibre-gl";
import Controls, { type Filters } from "./Controls";
import SearchBar, { type LocateResult } from "./SearchBar";
import Details from "./Details";
import Legend from "./Legend";
import {
  composite, PRESETS,
  type BlockGroupProps, type Facility, type Meta, type Weights,
} from "@/app/lib/types";

/**
 * Sequential blue ramp, stepped separately for each surface. The dark column is
 * not an inversion — it is the same hue re-stepped so the lightest score still
 * reads against a dark basemap.
 */
const RAMP_LIGHT = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const RAMP_DARK  = ["#0d366b", "#184f95", "#256abf", "#2a78d6", "#3987e5", "#6da7ec", "#b7d3f6"];
const STOPS = [0, 30, 50, 65, 78, 89, 100];

const BASEMAP = {
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

/**
 * Both sources are handed to MapLibre as URLs, not as parsed objects. MapLibre
 * then fetches and parses them inside its own worker; passing a parsed object
 * instead forces a main-thread parse plus a structured clone of several MB.
 */
const URL_BG = "/data/blockgroups.json";
const URL_SUPPLY = "/data/supply.json";

const SRC_BG = "bg";
const SRC_SUPPLY = "supply";
const SRC_RINGS = "rings";

const KIND_LABEL: Record<string, string> = {
  montessori: "Montessori",
  center: "Day care center",
  group_home: "Group day care home",
  home: "Licensed in-home day care",
  school: "K-12 school",
};

/** Subscribe to the OS colour scheme without mirroring it into state. */
const DARK_QUERY = "(prefers-color-scheme: dark)";
function subscribeToTheme(onChange: () => void) {
  const mq = window.matchMedia(DARK_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Approximate circle as a polygon, for the distance rings around home base. */
function ringPolygon([lon, lat]: [number, number], miles: number, steps = 128) {
  const dy = miles / 69.172;
  const dx = miles / (69.172 * Math.cos((lat * Math.PI) / 180));
  const coords: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    coords.push([lon + dx * Math.cos(a), lat + dy * Math.sin(a)]);
  }
  return {
    type: "Feature" as const,
    properties: { miles },
    geometry: { type: "Polygon" as const, coordinates: [coords] },
  };
}

export default function SiteMap() {
  const mapRef = useRef<MapLibreMap | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<MapLibrePopup | null>(null);
  const searchMarkerRef = useRef<{ setLngLat(l: [number, number]): unknown; remove(): void } | null>(null);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [scores, setScores] = useState<BlockGroupProps[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [styleReady, setStyleReady] = useState(false);

  // Drives both the basemap style and which end of the blue ramp is "dark".
  const dark = useSyncExternalStore(
    subscribeToTheme,
    () => window.matchMedia(DARK_QUERY).matches,
    () => false // server render: assume light, corrected on hydration
  );

  const [weights, setWeights] = useState<Weights>(PRESETS.balanced.weights);
  const [activePreset, setActivePreset] = useState<string | null>("balanced");
  const [selected, setSelected] = useState<BlockGroupProps | null>(null);
  // Which sheet is open on phones. Ignored at md+ where both panels are static
  // sidebars, so map clicks can set it unconditionally.
  const [mobilePanel, setMobilePanel] = useState<"controls" | "list" | null>(null);
  const [filters, setFilters] = useState<Filters>({
    counties: new Set<string>(),
    minKids: 150,
    maxHomeMiles: 60,
    showCenters: true,
    showHomes: false,
    showSchools: false,
    showRings: true,
  });

  // --- Load the app-side data (no geometry; the map fetches that itself) ----
  useEffect(() => {
    (async () => {
      try {
        const [m, s] = await Promise.all([
          fetch("/data/meta.json").then((r) => r.json()),
          fetch("/data/scores.json").then((r) => r.json()),
        ]);
        setMeta(m);
        setScores(s);
        setFilters((f) => ({ ...f, counties: new Set<string>(m.counties) }));
      } catch (err) {
        setLoadError(
          "Could not load /data. Run `npm run data` first to build the demographic files."
        );
        console.error(err);
      }
    })();
  }, []);

  const scoreIndex = useMemo(
    () => new Map(scores.map((s) => [s.geoid, s])),
    [scores]
  );

  /** Live composite for one block group under the current weights. */
  const scoreOf = useCallback(
    (props: BlockGroupProps) => (meta ? composite(props, weights, meta.factors) : null),
    [meta, weights]
  );

  // --- Build map layers (re-runs whenever the basemap style is swapped) -----
  const addLayers = useCallback(
    (map: MapLibreMap) => {
      if (!meta) return;
      const ramp = dark ? RAMP_DARK : RAMP_LIGHT;

      if (!map.getSource(SRC_BG)) {
        map.addSource(SRC_BG, { type: "geojson", data: URL_BG, promoteId: "geoid" });
      }
      if (!map.getSource(SRC_SUPPLY)) {
        map.addSource(SRC_SUPPLY, { type: "geojson", data: URL_SUPPLY });
      }
      if (!map.getSource(SRC_RINGS)) {
        map.addSource(SRC_RINGS, {
          type: "geojson",
          data: {
            type: "FeatureCollection",
            features: [1, 3, 10].map((mi) => ringPolygon(meta.homeBase.lonLat, mi)),
          } as GeoJSON.FeatureCollection,
        });
      }

      // Paint from the baked-in default-weight `score` property immediately,
      // and let feature-state override it once live weights are applied.
      const colorExpr: ExpressionSpecification = [
        "interpolate", ["linear"],
        ["coalesce", ["feature-state", "score"], ["get", "score"], 0],
        ...STOPS.flatMap((s, i) => [s, ramp[i]]),
      ];

      if (!map.getLayer("bg-fill")) {
        // Block groups excluded by the active filters render as a diagonal
        // hatch instead of disappearing: a bare-basemap hole is
        // indistinguishable from missing data, and every block group here has
        // data. setStyle clears custom images, so re-create on each style load.
        if (!map.hasImage("hatch-excluded")) {
          const size = 8;
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext("2d")!;
          ctx.strokeStyle = dark ? "#77776e" : "#b0b0a8";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          // Main anti-diagonal plus both cut corners, so the tile is seamless.
          ctx.moveTo(0, size); ctx.lineTo(size, 0);
          ctx.moveTo(-1, 1); ctx.lineTo(1, -1);
          ctx.moveTo(size - 1, size + 1); ctx.lineTo(size + 1, size - 1);
          ctx.stroke();
          map.addImage("hatch-excluded", ctx.getImageData(0, 0, size, size), { pixelRatio: 2 });
        }
        map.addLayer({
          id: "bg-excluded",
          type: "fill",
          source: SRC_BG,
          filter: ["==", ["get", "geoid"], ""], // populated by the filter effect
          paint: {
            "fill-pattern": "hatch-excluded",
            "fill-opacity": 0.7,
          },
        });
        map.addLayer({
          id: "bg-fill",
          type: "fill",
          source: SRC_BG,
          paint: { "fill-color": colorExpr, "fill-opacity": 0.72 },
        });
        map.addLayer({
          id: "bg-line",
          type: "line",
          source: SRC_BG,
          paint: {
            "line-color": dark ? "#000000" : "#ffffff",
            "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0, 11, 0.3, 14, 0.8],
            "line-opacity": 0.5,
          },
        });
        map.addLayer({
          id: "bg-selected",
          type: "line",
          source: SRC_BG,
          filter: ["==", ["get", "geoid"], ""],
          paint: { "line-color": dark ? "#ffffff" : "#0b0b0b", "line-width": 2.5 },
        });
      }

      if (!map.getLayer("rings-line")) {
        map.addLayer({
          id: "rings-line",
          type: "line",
          source: SRC_RINGS,
          paint: {
            "line-color": dark ? "#9085e9" : "#4a3aa7",
            "line-width": 1.5,
            "line-dasharray": [3, 2],
            "line-opacity": 0.8,
          },
        });
      }

      if (!map.getLayer("schools")) {
        map.addLayer({
          id: "schools",
          type: "circle",
          source: SRC_SUPPLY,
          filter: ["==", ["get", "kind"], "school"],
          paint: {
            "circle-color": dark ? "#6f6f6a" : "#8a8a85",
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 14, 4],
            "circle-opacity": 0.75,
          },
        });
      }
      // In-home licensed providers are the most numerous, so they render
      // smallest and sit underneath centers.
      if (!map.getLayer("homes")) {
        map.addLayer({
          id: "homes",
          type: "circle",
          source: SRC_SUPPLY,
          filter: ["in", ["get", "kind"], ["literal", ["home", "group_home"]]],
          paint: {
            "circle-color": dark ? "#d95926" : "#eb6834",
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 14, 3.5],
            "circle-opacity": 0.55,
          },
        });
      }
      if (!map.getLayer("centers")) {
        map.addLayer({
          id: "centers",
          type: "circle",
          source: SRC_SUPPLY,
          filter: ["==", ["get", "kind"], "center"],
          paint: {
            "circle-color": dark ? "#d95926" : "#eb6834",
            "circle-radius": [
              "interpolate", ["linear"], ["zoom"],
              9, ["interpolate", ["linear"], ["get", "capacity"], 20, 2, 200, 4.5],
              14, ["interpolate", ["linear"], ["get", "capacity"], 20, 4.5, 200, 12],
            ],
            "circle-stroke-width": 1,
            "circle-stroke-color": dark ? "#121211" : "#ffffff",
            "circle-opacity": 0.9,
          },
        });
        map.addLayer({
          id: "montessori",
          type: "circle",
          source: SRC_SUPPLY,
          filter: ["==", ["get", "kind"], "montessori"],
          paint: {
            "circle-color": dark ? "#f97316" : "#c2410c",
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 4, 14, 11],
            "circle-stroke-width": 2.5,
            "circle-stroke-color": dark ? "#121211" : "#ffffff",
          },
        });
      }
    },
    [meta, dark]
  );

  // --- Initialise the map ---------------------------------------------------
  useEffect(() => {
    if (!containerRef.current || !meta || mapRef.current) return;
    let cancelled = false;

    (async () => {
      // Imported lazily so MapLibre never runs during server rendering.
      const ml = await import("maplibre-gl");
      if (cancelled || !containerRef.current) return;

      // maplibre-gl v6 resolves its worker relative to the bundled module,
      // which 404s under Turbopack and leaves the map permanently empty (no
      // GeoJSON, no tiles, no error). Point it at the self-hosted copy that
      // scripts/copy-worker.mjs keeps in sync with the installed version.
      ml.setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

      const map = new ml.Map({
        container: containerRef.current,
        style: dark ? BASEMAP.dark : BASEMAP.light,
        center: meta.homeBase.lonLat,
        zoom: 9.2,
        maxZoom: 16,
        minZoom: 7,
      });
      mapRef.current = map;
      // Exposed for debugging from the browser console.
      (window as unknown as { __map?: MapLibreMap }).__map = map;

      // The dynamic import can resolve before the browser has laid the
      // container out, in which case MapLibre measures a stale size and the
      // canvas keeps the wrong drawing-buffer dimensions.
      requestAnimationFrame(() => map.resize());

      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      map.addControl(new ml.ScaleControl({ unit: "imperial" }), "bottom-right");

      popupRef.current = new ml.Popup({ closeButton: false, closeOnClick: false, offset: 10 });

      // Surface failures instead of leaving a silently blank map.
      map.on("error", (e) => {
        const message = String(e.error?.message ?? e.error ?? "unknown map error");
        console.error("[map]", message);
        setMapError(message);
      });

      map.on("style.load", () => {
        addLayers(map);
        setStyleReady(true);
      });
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // `dark` and `addLayers` are deliberately excluded: the style swap and the
    // layer rebuild have their own effects rather than tearing the map down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // Keep the canvas sized to its container, including the very first layout.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => mapRef.current?.resize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [meta]);

  // --- Interaction handlers -------------------------------------------------
  // Re-bound whenever the scoring function changes, so the hover popup always
  // reports the score for the weights currently on screen.
  useEffect(() => {
    const map = mapRef.current;
    const popup = popupRef.current;
    if (!map || !popup || !styleReady) return;

    const setCursor = (value: string) => { map.getCanvas().style.cursor = value; };
    const facilityLayers = ["homes", "centers", "montessori", "schools"];

    const onBgMove = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      setCursor("pointer");
      const geoid = String(f.properties?.geoid ?? "");
      const full = scoreIndex.get(geoid);
      const live = full ? scoreOf(full) : null;
      popup
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-weight:600;margin-bottom:2px">${
            f.properties?.place ?? f.properties?.county + " County"
          } · score ${live === null ? "—" : live.toFixed(0)}</div>
           <div style="color:var(--text-secondary)">
             ${Number(f.properties?.kids0to4_1mi).toLocaleString()} kids 0–4 within 1 mi<br/>
             ${Number(f.properties?.competitors1mi)} licensed providers within 1 mi<br/>
             ${Number(f.properties?.kidsPerSlot1mi).toFixed(1)} kids per licensed slot
           </div>`
        )
        .addTo(map);
    };
    const onBgLeave = () => { setCursor(""); popup.remove(); };
    const onBgClick = (e: MapLayerMouseEvent) => {
      // A tap on a facility marker also lands on the fill underneath; let the
      // facility popup win instead of yanking the details sheet open.
      const present = facilityLayers.filter((l) => map.getLayer(l));
      if (present.length && map.queryRenderedFeatures(e.point, { layers: present }).length) return;
      const geoid = String(e.features?.[0]?.properties?.geoid ?? "");
      const full = scoreIndex.get(geoid);
      if (full) {
        setSelected(full);
        setMobilePanel("list");
      }
    };
    const onFacilityEnter = () => setCursor("pointer");
    const onFacilityLeave = () => setCursor("");
    const onFacilityClick = (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties as unknown as Facility;
      popup
        .setLngLat(f.geometry.coordinates as [number, number])
        .setHTML(
          `<div style="font-weight:600">${p.name}</div>
           <div style="color:var(--text-secondary)">${KIND_LABEL[p.kind] ?? p.kind}${
             p.city ? ` · ${p.city}` : ""
           }</div>
           ${p.street ? `<div style="color:var(--text-muted)">${p.street}</div>` : ""}
           ${
             p.source === "dcfs"
               ? `<div style="color:var(--text-muted)">licensed capacity ${p.capacity}${
                   p.ageRange ? ` · ages ${p.ageRange}` : ""
                 }</div>`
               : ""
           }`
        )
        .addTo(map);
    };

    // Grayed-out (filtered) block groups stay inspectable — they have data too.
    const bgLayers = ["bg-fill", "bg-excluded"];
    for (const layer of bgLayers) {
      map.on("mousemove", layer, onBgMove);
      map.on("mouseleave", layer, onBgLeave);
      map.on("click", layer, onBgClick);
    }
    for (const layer of facilityLayers) {
      map.on("mouseenter", layer, onFacilityEnter);
      map.on("mouseleave", layer, onFacilityLeave);
      map.on("click", layer, onFacilityClick);
    }

    return () => {
      for (const layer of bgLayers) {
        map.off("mousemove", layer, onBgMove);
        map.off("mouseleave", layer, onBgLeave);
        map.off("click", layer, onBgClick);
      }
      for (const layer of facilityLayers) {
        map.off("mouseenter", layer, onFacilityEnter);
        map.off("mouseleave", layer, onFacilityLeave);
        map.off("click", layer, onFacilityClick);
      }
    };
  }, [styleReady, scoreOf, scoreIndex]);

  // --- Swap the basemap when the colour scheme changes ---------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    setStyleReady(false);
    map.setStyle(dark ? BASEMAP.dark : BASEMAP.light);
    // `style.load` fires again and re-adds every layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);

  // --- Push live scores into feature state ---------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !meta || !scores.length) return;
    const handle = window.setTimeout(() => {
      for (const p of scores) {
        map.setFeatureState({ source: SRC_BG, id: p.geoid }, { score: composite(p, weights, meta.factors) });
      }
    }, 60);
    return () => window.clearTimeout(handle);
  }, [weights, scores, styleReady, meta]);

  // --- Apply filters --------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !filters.counties.size) return;
    const inCounties: FilterSpecification = ["in", ["get", "county"], ["literal", [...filters.counties]]];
    const passes: FilterSpecification = [
      "all",
      [">=", ["get", "kids0to4_1mi"], filters.minKids],
      ["<=", ["get", "homeMiles"], filters.maxHomeMiles >= 60 ? 9999 : filters.maxHomeMiles],
    ];
    for (const id of ["bg-fill", "bg-line"]) {
      if (map.getLayer(id)) map.setFilter(id, ["all", inCounties, passes]);
    }
    // Gray, not gone: block groups in an enabled county that fail the sliders.
    // Counties toggled off vanish entirely — that exclusion is deliberate.
    if (map.getLayer("bg-excluded")) {
      map.setFilter("bg-excluded", ["all", inCounties, ["!", passes]]);
    }
    if (map.getLayer("centers")) {
      const centersVis = filters.showCenters ? "visible" : "none";
      map.setLayoutProperty("centers", "visibility", centersVis);
      map.setLayoutProperty("montessori", "visibility", centersVis);
    }
    if (map.getLayer("homes")) {
      map.setLayoutProperty("homes", "visibility", filters.showHomes ? "visible" : "none");
    }
    if (map.getLayer("schools")) {
      map.setLayoutProperty("schools", "visibility", filters.showSchools ? "visible" : "none");
    }
    if (map.getLayer("rings-line")) {
      map.setLayoutProperty("rings-line", "visibility", filters.showRings ? "visible" : "none");
    }
  }, [filters, styleReady]);

  // --- Highlight the selected block group ----------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !map.getLayer("bg-selected")) return;
    map.setFilter("bg-selected", ["==", ["get", "geoid"], selected?.geoid ?? ""]);
  }, [selected, styleReady]);

  // --- Ranked shortlist -----------------------------------------------------
  const ranked = useMemo(() => {
    if (!meta) return [];
    return scores
      .filter(
        (p) =>
          filters.counties.has(p.county) &&
          p.kids0to4_1mi >= filters.minKids &&
          (filters.maxHomeMiles >= 60 || p.homeMiles <= filters.maxHomeMiles)
      )
      .map((p) => ({ p, s: composite(p, weights, meta.factors) }))
      .filter((r): r is { p: BlockGroupProps; s: number } => r.s !== null)
      .sort((a, b) => b.s - a.s)
      .slice(0, 25);
  }, [scores, weights, filters, meta]);

  /** Address search: pin the exact address, select and zoom to its block group. */
  const onLocated = async (r: LocateResult) => {
    const full = scoreIndex.get(r.geoid);
    if (full) setSelected(full);
    const map = mapRef.current;
    if (!map) return;
    const ml = await import("maplibre-gl");
    if (!searchMarkerRef.current) {
      searchMarkerRef.current = new ml.Marker({ color: "#4a3aa7" }).setLngLat([r.lon, r.lat]).addTo(map);
    } else {
      searchMarkerRef.current.setLngLat([r.lon, r.lat]);
    }
    if (full?.bbox) {
      const [minX, minY, maxX, maxY] = full.bbox;
      map.fitBounds(
        [[Math.min(minX, r.lon), Math.min(minY, r.lat)], [Math.max(maxX, r.lon), Math.max(maxY, r.lat)]],
        { padding: 200, maxZoom: 14, duration: 900 }
      );
    } else {
      map.flyTo({ center: [r.lon, r.lat], zoom: 13, duration: 900 });
    }
  };

  const flyTo = (p: BlockGroupProps) => {
    setSelected(p);
    setMobilePanel(null); // on phones, drop the sheet so the map is visible
    const map = mapRef.current;
    if (!map || !p.bbox) return;
    const [minX, minY, maxX, maxY] = p.bbox;
    map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 220, maxZoom: 14, duration: 900 });
  };

  if (loadError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="max-w-lg text-sm" style={{ color: "var(--text-secondary)" }}>{loadError}</p>
      </div>
    );
  }

  if (!meta) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading demographic data…</p>
      </div>
    );
  }

  // Below md both panels render as bottom sheets slid offscreen until toggled;
  // at md+ the same nodes become the static sidebars of the desktop layout.
  const sheetClass = (open: boolean) =>
    "fixed inset-x-0 bottom-0 z-30 max-h-[75dvh] overflow-y-auto rounded-t-2xl border-t p-4 " +
    "pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl transition-transform duration-200 " +
    (open ? "translate-y-0 " : "translate-y-full ") +
    "md:static md:z-auto md:max-h-none md:translate-y-0 md:rounded-none md:border-t-0 md:shrink-0 md:shadow-none md:transition-none";

  const doneButton = (
    <button
      onClick={() => setMobilePanel(null)}
      className="rounded-full border px-3 py-1 text-[11px] font-medium md:hidden"
      style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
    >
      Done
    </button>
  );

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Controls ---------------------------------------------------------- */}
      <aside
        className={`${sheetClass(mobilePanel === "controls")} md:w-[320px] md:border-r`}
        style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
      >
        <div className="flex items-start justify-between gap-2">
          <h1 className="text-sm font-semibold">Montessori site finder</h1>
          {doneButton}
        </div>
        <p className="mt-0.5 mb-4 text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>
          {meta.blockGroups.toLocaleString()} block groups · {meta.facilities.toLocaleString()} licensed providers ·
          ACS {meta.acsYear} 5-year
        </p>
        <Controls
          meta={meta}
          weights={weights}
          setWeights={setWeights}
          filters={filters}
          setFilters={setFilters}
          activePreset={activePreset}
          setActivePreset={setActivePreset}
        />
      </aside>

      {/* Map --------------------------------------------------------------- */}
      <div className="relative flex-1">
        <div ref={containerRef} className="h-full w-full" />
        <SearchBar onLocated={onLocated} />
        <Legend meta={meta} showSchools={filters.showSchools} showHomes={filters.showHomes} />
        {mapError && (
          <div
            className="absolute top-4 left-1/2 z-20 -translate-x-1/2 rounded-md border px-3 py-2 text-xs shadow-lg"
            style={{ borderColor: "var(--border)", background: "var(--surface-1)", color: "var(--text-primary)" }}
          >
            Map error: {mapError}
          </div>
        )}
      </div>

      {/* Shortlist / detail ------------------------------------------------- */}
      <aside
        className={`${sheetClass(mobilePanel === "list")} md:w-[330px] md:border-l`}
        style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
      >
        {selected ? (
          <>
            <div className="mb-3 flex items-center justify-between gap-2">
              <button
                onClick={() => setSelected(null)}
                className="text-[11px] underline"
                style={{ color: "var(--text-muted)" }}
              >
                ← Back to shortlist
              </button>
              {doneButton}
            </div>
            <Details props={selected} liveScore={scoreOf(selected)} meta={meta} />
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-semibold">Top locations</h3>
              {doneButton}
            </div>
            <p className="mt-0.5 mb-3 text-[11px] leading-snug" style={{ color: "var(--text-muted)" }}>
              Highest-scoring block groups under the current weights and filters. Click one to zoom.
            </p>
            <ol className="space-y-1">
              {ranked.map(({ p, s }, i) => (
                <li key={p.geoid}>
                  <button
                    onClick={() => flyTo(p)}
                    className="w-full rounded border px-2 py-1.5 text-left transition-colors hover:opacity-90"
                    style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
                  >
                    <div className="flex items-baseline justify-between">
                      <span className="truncate pr-2 text-[11px] font-medium">
                        {i + 1}. {p.place ?? `${p.county} County`}
                      </span>
                      <span className="font-mono text-xs tabular-nums" style={{ color: "var(--accent)" }}>
                        {s.toFixed(0)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {p.county} Co · {p.kids0to4_1mi.toLocaleString()} kids 0–4 · {p.competitors1mi} providers · {p.homeMiles} mi
                    </div>
                  </button>
                </li>
              ))}
              {!ranked.length && (
                <li className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  No block groups match the current filters.
                </li>
              )}
            </ol>
          </>
        )}
      </aside>

      {/* Mobile chrome: backdrop behind the open sheet + toggles ------------ */}
      {mobilePanel && (
        <div
          className="fixed inset-0 z-20 bg-black/30 md:hidden"
          onClick={() => setMobilePanel(null)}
          aria-hidden
        />
      )}
      <div
        className="pointer-events-none fixed inset-x-0 z-10 flex justify-center gap-2 md:hidden"
        style={{ bottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        {([["controls", "Filters & weights"], ["list", selected ? "Details" : "Top spots"]] as const).map(
          ([panel, label]) => (
            <button
              key={panel}
              onClick={() => setMobilePanel(panel)}
              className="pointer-events-auto rounded-full border px-4 py-2 text-xs font-medium shadow-lg backdrop-blur"
              style={{
                borderColor: "var(--border)",
                background: "color-mix(in srgb, var(--surface-1) 94%, transparent)",
                color: "var(--text-primary)",
              }}
            >
              {label}
            </button>
          )
        )}
      </div>
    </div>
  );
}
