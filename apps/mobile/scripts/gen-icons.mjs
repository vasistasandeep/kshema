// Generates the raster PNG app-icon assets Expo requires from the brand SVGs in
// ./assets. Expo cannot use SVG for icons, so we rasterize once here. Uses
// `sharp` via npx (fetched on demand) so nothing extra is added to the
// dependency tree. Run: `node scripts/gen-icons.mjs` (or `pnpm gen:icons`).
//
// Outputs:
//   assets/icon.png           1024x1024  (iOS + generic app icon)
//   assets/adaptive-icon.png  1024x1024  (Android adaptive foreground)
//   assets/splash-icon.png     512x512   (splash mark)
//   assets/favicon.png          48x48    (Expo web favicon)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "assets");

const jobs = [
  { src: "icon.svg", out: "icon.png", size: 1024 },
  { src: "adaptive-icon.svg", out: "adaptive-icon.png", size: 1024 },
  { src: "icon.svg", out: "splash-icon.png", size: 512 },
  { src: "icon.svg", out: "favicon.png", size: 48 },
];

for (const j of jobs) {
  const src = join(assets, j.src);
  const out = join(assets, j.out);
  if (!existsSync(src)) {
    console.error(`[gen-icons] missing source ${src}`);
    process.exit(1);
  }
  // sharp-cli: `npx sharp -i in.svg -o out.png resize <size> <size>`
  const res = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["--yes", "sharp-cli", "-i", src, "-o", out, "resize", String(j.size), String(j.size)],
    { stdio: "inherit" },
  );
  if (res.status !== 0) {
    console.error(`[gen-icons] failed for ${j.out}. You can also generate icons at https://icon.kitchen using assets/icon.svg`);
    process.exit(res.status ?? 1);
  }
  console.log(`[gen-icons] wrote assets/${j.out}`);
}
console.log("[gen-icons] done. app.json already references these files.");