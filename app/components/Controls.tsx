"use client";

import { PRESETS, type FactorKey, type Meta, type Weights } from "@/app/lib/types";

export interface Filters {
  counties: Set<string>;
  minKids: number;
  maxHomeMiles: number;
  showCenters: boolean;
  showHomes: boolean;
  showSchools: boolean;
  showRings: boolean;
}

export default function Controls({
  meta, weights, setWeights, filters, setFilters, activePreset, setActivePreset,
}: {
  meta: Meta;
  weights: Weights;
  setWeights: (w: Weights) => void;
  filters: Filters;
  setFilters: (f: Filters) => void;
  activePreset: string | null;
  setActivePreset: (p: string | null) => void;
}) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);

  const setWeight = (key: FactorKey, value: number) => {
    setWeights({ ...weights, [key]: value });
    setActivePreset(null); // sliders diverge from the preset
  };

  const toggleCounty = (c: string) => {
    const next = new Set(filters.counties);
    if (next.has(c)) next.delete(c);
    else next.add(c);
    if (next.size === 0) return; // never blank the map entirely
    setFilters({ ...filters, counties: next });
  };

  return (
    <div className="space-y-5">
      {/* --- Presets ------------------------------------------------------- */}
      <section>
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Strategy
        </h4>
        <div className="grid grid-cols-2 gap-1.5">
          {Object.entries(PRESETS).map(([key, preset]) => {
            const active = activePreset === key;
            return (
              <button
                key={key}
                onClick={() => { setWeights(preset.weights); setActivePreset(key); }}
                title={preset.blurb}
                className="rounded border px-2 py-1.5 text-left text-[11px] transition-colors"
                style={{
                  borderColor: active ? "var(--accent)" : "var(--border)",
                  background: active ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--surface-1)",
                  color: active ? "var(--accent)" : "var(--text-secondary)",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[10px] leading-snug" style={{ color: "var(--text-muted)" }}>
          {activePreset ? PRESETS[activePreset]?.blurb : "Custom weights."}
        </p>
      </section>

      {/* --- Weights ------------------------------------------------------- */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Weights
          </h4>
          <span className="font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
            Σ {total.toFixed(2)}
          </span>
        </div>
        <div className="space-y-2.5">
          {meta.factors.map((f) => (
            <div key={f.key}>
              <div className="flex items-baseline justify-between">
                <label htmlFor={`w-${f.key}`} className="text-[11px]" style={{ color: "var(--text-secondary)" }} title={f.help}>
                  {f.label}
                </label>
                <span className="font-mono text-[10px] tabular-nums" style={{ color: "var(--text-muted)" }}>
                  {(weights[f.key] * 100).toFixed(0)}%
                </span>
              </div>
              <input
                id={`w-${f.key}`}
                type="range"
                min={0}
                max={0.5}
                step={0.01}
                value={weights[f.key]}
                onChange={(e) => setWeight(f.key, Number(e.target.value))}
                className="mt-1 w-full"
              />
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[10px] leading-snug" style={{ color: "var(--text-muted)" }}>
          Weights are normalised, so only their ratios matter.
        </p>
      </section>

      {/* --- Filters ------------------------------------------------------- */}
      <section>
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Filters
        </h4>

        <div className="mb-3">
          <div className="mb-1 flex justify-between text-[11px]">
            <span style={{ color: "var(--text-secondary)" }}>Min. children 0–4 within 1 mi</span>
            <span className="font-mono tabular-nums" style={{ color: "var(--text-muted)" }}>{filters.minKids}</span>
          </div>
          <input
            type="range" min={0} max={600} step={25}
            value={filters.minKids}
            onChange={(e) => setFilters({ ...filters, minKids: Number(e.target.value) })}
            className="w-full"
          />
          <p className="mt-0.5 text-[10px] leading-snug" style={{ color: "var(--text-muted)" }}>
            Hides thin markets that score well only because nobody competes there.
          </p>
        </div>

        <div className="mb-3">
          <div className="mb-1 flex justify-between text-[11px]">
            <span style={{ color: "var(--text-secondary)" }}>Max drive distance from {meta.homeBase.zip}</span>
            <span className="font-mono tabular-nums" style={{ color: "var(--text-muted)" }}>
              {filters.maxHomeMiles >= 60 ? "any" : `${filters.maxHomeMiles} mi`}
            </span>
          </div>
          <input
            type="range" min={5} max={60} step={5}
            value={filters.maxHomeMiles}
            onChange={(e) => setFilters({ ...filters, maxHomeMiles: Number(e.target.value) })}
            className="w-full"
          />
        </div>

        <div className="mb-3">
          <div className="mb-1 text-[11px]" style={{ color: "var(--text-secondary)" }}>Counties</div>
          <div className="flex flex-wrap gap-1">
            {meta.counties.map((c) => {
              const on = filters.counties.has(c);
              return (
                <button
                  key={c}
                  onClick={() => toggleCounty(c)}
                  className="rounded-full border px-2 py-0.5 text-[10px] transition-colors"
                  style={{
                    borderColor: on ? "var(--accent)" : "var(--border)",
                    background: on ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "transparent",
                    color: on ? "var(--accent)" : "var(--text-muted)",
                  }}
                >
                  {c}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          {([
            ["showCenters", "Show childcare centers"],
            ["showHomes", "Show licensed in-home daycare"],
            ["showSchools", "Show K-12 schools"],
            ["showRings", `Show ${meta.radii.primary}/${meta.radii.secondary}/10 mi rings`],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex cursor-pointer items-center gap-2 text-[11px]" style={{ color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={filters[key]}
                onChange={(e) => setFilters({ ...filters, [key]: e.target.checked })}
                style={{ accentColor: "var(--accent)" }}
              />
              {label}
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
