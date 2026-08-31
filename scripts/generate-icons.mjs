import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconDirectory = path.join(repositoryRoot, "icons");
const sizes = [16, 32, 48, 128];
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="26" fill="#111827"/>
  <rect x="37" y="24" width="54" height="80" rx="7" fill="none" stroke="#F8FAFC" stroke-width="7"/>
  <path d="M24 43V24h19M85 24h19v19M104 85v19H85M43 104H24V85" fill="none" stroke="#3B82F6" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M49 48h30M49 63h30M49 78h21" fill="none" stroke="#94A3B8" stroke-width="5" stroke-linecap="round"/>
</svg>`;

await fs.mkdir(iconDirectory, { recursive: true });
for (const size of sizes) {
  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(path.join(iconDirectory, `icon-${size}.png`));
}

process.stdout.write(`Generated ${sizes.length} local extension icons.\n`);
