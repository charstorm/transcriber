// Copies the runtime assets that @ricky0123/vad-web fetches at runtime into
// public/vad/, so the app works fully offline (no CDN).
// Runs before `dev` and `build` (see package.json scripts).
//
// Important: vad-web bundles its OWN copy of onnxruntime-web (currently 1.14.0)
// in its nested node_modules. The WASM we ship MUST match that exact version,
// so we copy from vad-web's nested onnxruntime-web, not any hoisted top-level one.
import { mkdirSync, copyFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "vad");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const vadDist = join(root, "node_modules", "@ricky0123", "vad-web", "dist");
const nestedOrt = join(
  root,
  "node_modules",
  "@ricky0123",
  "vad-web",
  "node_modules",
  "onnxruntime-web",
  "dist"
);
const topOrt = join(root, "node_modules", "onnxruntime-web", "dist");
const ortDist = existsSync(nestedOrt) ? nestedOrt : topOrt;

const copy = (from, file) => {
  copyFileSync(join(from, file), join(outDir, file));
  console.log("  copied", file);
};

// VAD worklet + Silero models
copy(vadDist, "vad.worklet.bundle.min.js");
copy(vadDist, "silero_vad_v5.onnx");
copy(vadDist, "silero_vad_legacy.onnx");

// onnxruntime-web wasm (+ any .mjs glue) for the version vad-web actually uses
for (const f of readdirSync(ortDist)) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(f)) copy(ortDist, f);
}

console.log("VAD assets ready in public/vad/ (ort from " +
  (ortDist === nestedOrt ? "nested vad-web" : "top-level") + ")");
