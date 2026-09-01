"use client";

import type { BlockGroupProps, Factor, Meta } from "@/app/lib/types";

const fmtInt = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Math.round(n).toLocaleString();
const fmtUsd = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `$${Math.round(n).toLocaleString()}`;
const fmtPct = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${(n * 100).toFixed(0)}%`;

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs" style={{ color: "var(--text-secondary)" }} title={hint}>
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums" style={{ color: "var(--text-primary)" }}>
        {value}
      </span>
    </div>
  );
}

function FactorBar({ factor, value }: { factor: Factor; value: number | null | undefined }) {
  const v = value ?? null;
  return (
    <div className="py-1" title={factor.help}>
      <div className="flex justify-between text-[11px]">
        <span style={{ color: "var(--text-secondary)" }}>{factor.label}</span>
        <span className="font-mono tabular-nums" style={{ color: "var(--text-muted)" }}>
          {v === null ? "n/a" : v.toFixed(0)}
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-2)" }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${v ?? 0}%`, background: v === null ? "var(--text-muted)" : "var(--accent)" }}
        />
      </div>
    </div>
  );
}

export default function Details({
  props: p,
  liveScore,
  meta,
}: {
  props: BlockGroupProps;
  liveScore: number | null;
  meta: Meta;
}) {
  const thin = p.kids0to4_1mi < 150;

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {p.place ?? "Unknown area"}
            <span className="font-normal" style={{ color: "var(--text-muted)" }}> · {p.county} County</span>
          </h3>
          <span className="shrink-0 font-mono text-[10px]" style={{ color: "var(--text-muted)" }}>
            {p.geoid}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 font-mono text-[11px]" style={{ color: "var(--text-secondary)" }}>
          <span>{p.lat.toFixed(5)}, {p.lon.toFixed(5)}</span>
          <a
            href={`https://www.google.com/maps?q=${p.lat.toFixed(5)},${p.lon.toFixed(5)}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
            style={{ color: "var(--accent)" }}
          >
            open in Google Maps
          </a>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums" style={{ color: "var(--accent)" }}>
            {liveScore === null ? "—" : liveScore.toFixed(0)}
          </span>
          <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
            site score · {p.homeMiles} mi from {meta.homeBase.zip}
          </span>
        </div>
        {thin && (
          <p
            className="mt-2 rounded border px-2 py-1.5 text-[11px]"
            style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text-secondary)" }}
          >
            Thin market: only {fmtInt(p.kids0to4_1mi)} children aged 0–4 within 1 mile. A high
            score here is driven by absence of competition, not by demand.
          </p>
        )}
      </div>

      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Demand within 1 mile
        </h4>
        <Row label="Children 0–4" value={fmtInt(p.kids0to4_1mi)} />
        <Row label="Children 5–9" value={fmtInt(p.kids5to9_1mi)} />
        <Row
          label="Under 6, all parents working"
          value={fmtInt(p.careNeed1mi)}
          hint="Children under 6 in families where every resident parent is in the labor force — the households that must buy care."
        />
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Existing supply
        </h4>
        <Row label="Licensed providers (1 mi)" value={fmtInt(p.competitors1mi)} />
        <Row label="— centers (1 mi)" value={fmtInt(p.centers1mi)} />
        <Row label="— in-home / group (1 mi)" value={fmtInt(p.homes1mi)} />
        <Row label="Montessori (1 mi)" value={fmtInt(p.montessori1mi)} />
        <Row label="K-12 schools (1 mi)" value={fmtInt(p.schools1mi)} />
        <Row
          label="Licensed slots (1 mi)"
          value={fmtInt(p.slots1mi)}
          hint="DCFS licensed day capacity within 1 mile, scaled by how much of the 0-6 age band each licence covers and discounted for in-home providers."
        />
        <Row
          label="Children per slot (1 mi)"
          value={p.kidsPerSlot1mi.toFixed(2)}
          hint="Working-parent children under 6 per weighted childcare slot within 1 mile. Higher means more underserved."
        />
        <Row label="Children per slot (3 mi)" value={p.kidsPerSlot3mi.toFixed(2)} />
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Neighborhood
        </h4>
        <Row label="Population" value={fmtInt(p.pop)} />
        <Row label="Change since 2020" value={p.popGrowth === null ? "—" : `${p.popGrowth > 0 ? "+" : ""}${fmtPct(p.popGrowth)}`} />
        <Row label="Housing built since 2010" value={fmtPct(p.newHousingShare)} />
        <Row
          label="Median household income"
          value={fmtUsd(p.medianHhIncome)}
          hint={p.incomeImputed ? "Suppressed by the Census for this block group; estimated from neighbours within 1.5 mi." : undefined}
        />
        {p.incomeImputed && (
          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            income estimated from neighbors
          </div>
        )}
        <Row label="Median home value" value={fmtUsd(p.medianHomeValue)} />
        <Row label="Bachelor's degree or higher" value={fmtPct(p.eduShare)} />
        <Row label="Households with kids &lt;18" value={fmtPct(p.kidsHhShare)} />
        <Row label="Owner-occupied" value={fmtPct(p.ownerShare)} />
      </section>

      <section>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
          Factor scores (percentile vs. region)
        </h4>
        {meta.factors.map((f) => (
          <FactorBar key={f.key} factor={f} value={p[f.key]} />
        ))}
      </section>
    </div>
  );
}
