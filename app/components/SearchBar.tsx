"use client";

import { useState } from "react";

export interface LocateResult {
  matchedAddress: string;
  lon: number;
  lat: number;
  geoid: string;
  place: string | null;
  county: string;
}

export default function SearchBar({ onLocated }: { onLocated: (r: LocateResult) => void }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  const search = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/locate?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (!res.ok) {
        setStatus({ kind: "error", text: json.error ?? "Search failed." });
        return;
      }
      setStatus({ kind: "ok", text: json.matchedAddress });
      onLocated(json as LocateResult);
    } catch {
      setStatus({ kind: "error", text: "Search failed — is the dev server running?" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute top-4 left-4 right-14 z-10 md:right-auto md:w-80">
      <div
        className="flex overflow-hidden rounded-lg border shadow-lg backdrop-blur"
        style={{
          borderColor: "var(--border)",
          background: "color-mix(in srgb, var(--surface-1) 94%, transparent)",
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
          placeholder="Score an address… e.g. 123 Main St, Naperville"
          className="w-full bg-transparent px-3 py-2 text-base outline-none md:text-xs"
          style={{ color: "var(--text-primary)" }}
          aria-label="Search an address"
        />
        <button
          onClick={search}
          disabled={busy}
          className="shrink-0 px-3 text-xs font-medium disabled:opacity-50"
          style={{ color: "var(--accent)" }}
        >
          {busy ? "…" : "Score"}
        </button>
      </div>
      {status && (
        <div
          className="mt-1 rounded border px-2 py-1 text-[11px] shadow"
          style={{
            borderColor: "var(--border)",
            background: "var(--surface-1)",
            color: status.kind === "error" ? "var(--competitor)" : "var(--text-secondary)",
          }}
        >
          {status.kind === "ok" ? `Found: ${status.text}` : status.text}
        </div>
      )}
    </div>
  );
}
