"use client";

import type { Meta } from "@/app/lib/types";

const RAMP = [
  "var(--seq-100)", "var(--seq-200)", "var(--seq-300)",
  "var(--seq-400)", "var(--seq-500)", "var(--seq-600)", "var(--seq-700)",
];

export default function Legend({ meta, showSchools, showHomes }: { meta: Meta; showSchools: boolean; showHomes: boolean }) {
  return (
    <div
      className="absolute bottom-6 left-6 z-10 hidden rounded-lg border p-3 text-xs shadow-lg backdrop-blur md:block"
      style={{
        background: "color-mix(in srgb, var(--surface-1) 92%, transparent)",
        borderColor: "var(--border)",
        color: "var(--text-primary)",
      }}
    >
      <div className="mb-1.5 font-semibold">Site score</div>
      <div className="flex h-3 w-52 overflow-hidden rounded-sm">
        {RAMP.map((c) => (
          <div key={c} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="mt-1 flex w-52 justify-between" style={{ color: "var(--text-secondary)" }}>
        <span>0 — weaker</span>
        <span>100 — stronger</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2" style={{ color: "var(--text-secondary)" }}>
        <span
          className="inline-block h-3 w-3 shrink-0 rounded-sm"
          style={{ background: "repeating-linear-gradient(45deg, transparent 0 2px, var(--excluded) 2px 3.5px)" }}
        />
        outside current filters (still has data)
      </div>

      <div className="mt-3 mb-1.5 font-semibold">Existing providers</div>
      <ul className="space-y-1" style={{ color: "var(--text-secondary)" }}>
        <li className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-full"
            style={{ background: "var(--montessori)", boxShadow: "0 0 0 2px var(--surface-1)", border: "1.5px solid var(--surface-1)" }}
          />
          Montessori (direct competitor)
        </li>
        <li className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: "var(--competitor)" }}
          />
          Day care center
        </li>
        {showHomes && (
          <li className="flex items-center gap-2">
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full opacity-60"
              style={{ background: "var(--competitor)" }}
            />
            Licensed in-home daycare
          </li>
        )}
        {showSchools && (
          <li className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--school)" }} />
            K-12 school
          </li>
        )}
      </ul>

      <div className="mt-2 pt-2 text-[10px] leading-relaxed" style={{ borderTop: "1px solid var(--border)", color: "var(--text-muted)" }}>
        Marker size scales with DCFS licensed capacity.
        <br />
        Rings show {meta.radii.primary} / {meta.radii.secondary} / 10 mi from {meta.homeBase.label}.
      </div>
    </div>
  );
}
