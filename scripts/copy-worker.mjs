// Self-host MapLibre's web worker.
//
// maplibre-gl v6 is ESM-only and derives its worker URL from `import.meta.url`
// of the bundled main module. Under Next.js/Turbopack that resolves into
// /_next/static/chunks/, where the worker file was never emitted — the request
// 404s with an HTML page ("Failed to load module script ... MIME type
// text/html") and every worker-dependent operation (GeoJSON parsing, vector
// tile decoding) silently hangs: a fully blank map with no error event.
//
// The fix is MapLibre's own escape hatch: copy the worker (and the shared
// chunk it imports) somewhere we control and call `setWorkerUrl()` before the
// first Map is constructed. This script runs via predev/prebuild so the copies
// can never drift from the installed maplibre-gl version.

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/maplibre-gl/dist");
const dest = join(root, "public/vendor/maplibre");

const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

mkdirSync(dest, { recursive: true });
for (const file of FILES) {
  const from = join(src, file);
  if (!existsSync(from)) {
    console.error(`copy-worker: ${from} not found — did the maplibre-gl layout change?`);
    process.exit(1);
  }
  copyFileSync(from, join(dest, file));
}
console.log(`copy-worker: ${FILES.join(", ")} -> public/vendor/maplibre/`);
