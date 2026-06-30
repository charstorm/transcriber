// Copies the UI fonts (Exo + JetBrains Mono) into public/fonts/ so the app
// loads them locally — no runtime network fetch, no CDN, works fully offline.
// Runs before `dev` and `build` (see package.json scripts), same pattern as
// scripts/copy-vad-assets.mjs.
//
// Fonts come from the @fontsource/* npm packages (downloaded once into
// node_modules). public/fonts/ is gitignored (we don't commit binaries); this
// script regenerates it from node_modules, so the set is reproducible.
import { mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "fonts");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Only the woff2 weights @font-face in styles.css references.
const FONTS = [
  ["@fontsource/exo", ["300", "400", "500", "600", "700"], "exo"],
  ["@fontsource/jetbrains-mono", ["300", "400"], "jetbrains-mono"],
];

let n = 0;
for (const [pkg, weights, slug] of FONTS) {
  const filesDir = join(root, "node_modules", pkg, "files");
  for (const w of weights) {
    const file = `${slug}-latin-${w}-normal.woff2`;
    copyFileSync(join(filesDir, file), join(outDir, file));
    console.log("  copied", file);
    n++;
  }
}

console.log(`Fonts ready in public/fonts/ (${n} woff2 files)`);
