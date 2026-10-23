import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = new URL("../apps/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktopDirectory));
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");
const artwork = await readFile(
  new URL("src/assets/xsh-icon.svg", desktopDirectory),
  "utf8",
);

// macOS displays the full icon canvas, so the artwork needs transparent margins.
const canvasSize = 1024;
const artworkSize = 824;
const inset = (canvasSize - artworkSize) / 2;
const scale = artworkSize / canvasSize;
const temporaryRoot = resolve(tmpdir());
const temporaryDirectory = await mkdtemp(join(temporaryRoot, "xsh-macos-icon-"));

try {
  const sourcePath = join(temporaryDirectory, "macos-icon.svg");
  await writeFile(
    sourcePath,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasSize}" height="${canvasSize}" viewBox="0 0 ${canvasSize} ${canvasSize}">
  <g transform="translate(${inset} ${inset}) scale(${scale})">
    ${artwork.trim()}
  </g>
</svg>
`,
  );
  execFileSync(
    process.execPath,
    [tauriCli, "icon", sourcePath, "--output", temporaryDirectory],
    { cwd: fileURLToPath(desktopDirectory), stdio: "inherit" },
  );
  await copyFile(
    join(temporaryDirectory, "icon.icns"),
    new URL("src-tauri/icons/icon.icns", desktopDirectory),
  );
  console.log("Generated macOS icon with 824×824 artwork on a 1024×1024 canvas.");
} finally {
  if (dirname(resolve(temporaryDirectory)) !== temporaryRoot) {
    throw new Error("Refusing to remove a directory outside the temporary root.");
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
