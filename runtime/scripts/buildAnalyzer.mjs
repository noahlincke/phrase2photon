import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bundles the analyser CLI into a single file the Python Now Playing service
 * can run with plain node.
 *
 * esbuild rather than tsc because this has to be cheap enough that nobody
 * skips it: a stale or missing bundle means Now Playing silently falls back to
 * guessing the tempo.
 */
const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..");

await build({
  entryPoints: [resolve(runtimeRoot, "scripts/analysis/analyzeCli.ts")],
  outfile: resolve(runtimeRoot, "dist-analyzer/analyze.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  logLevel: "info"
});
