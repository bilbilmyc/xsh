import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function inspectCodeSignature(bytes, offset, length, file) {
  if (length < 12 || offset + length > bytes.length) throw new Error(`Invalid code signature: ${file}`);
  const blob = bytes.subarray(offset, offset + length);
  const blobLength = blob.readUInt32BE(4);
  const count = blob.readUInt32BE(8);
  if (blob.readUInt32BE(0) !== 0xfade0cc0 || blobLength > length || 12 + count * 8 > blobLength) {
    throw new Error(`Invalid signature superblob: ${file}`);
  }
  for (let index = 0; index < count; index++) {
    const start = blob.readUInt32BE(16 + index * 8);
    if (start + 8 > blobLength) throw new Error(`Invalid signature slot: ${file}`);
    const size = blob.readUInt32BE(start + 4);
    if (size < 8 || start + size > blobLength) throw new Error(`Truncated signature slot: ${file}`);
    if (blob.readUInt32BE(start) !== 0xfade0c02) continue;
    if (size < 44) throw new Error(`Truncated CodeDirectory: ${file}`);
    const version = blob.readUInt32BE(start + 8);
    const flags = blob.readUInt32BE(start + 12);
    let teamId = null;
    if (version >= 0x20200) {
      if (size < 52) throw new Error(`Truncated CodeDirectory team: ${file}`);
      const teamOffset = blob.readUInt32BE(start + 48);
      if (teamOffset) {
        const teamStart = start + teamOffset;
        const teamEnd = blob.indexOf(0, teamStart);
        if (teamOffset < 52 || teamStart >= start + size || teamEnd < teamStart || teamEnd >= start + size) {
          throw new Error(`Invalid signing Team ID: ${file}`);
        }
        teamId = blob.toString("utf8", teamStart, teamEnd) || null;
      }
    }
    return { flags, teamId };
  }
  throw new Error(`Code signature has no CodeDirectory: ${file}`);
}

function inspectMachO(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`Expected a thin 64-bit Mach-O image: ${file}`);
  }
  const commandsEnd = 32 + bytes.readUInt32LE(20);
  if (commandsEnd > bytes.length) throw new Error(`Truncated Mach-O header: ${file}`);
  const image = { file, cpu: bytes.readUInt32LE(4), dependencies: [], rpaths: [] };
  let offset = 32;
  for (let index = 0; index < bytes.readUInt32LE(16); index++) {
    if (offset + 8 > commandsEnd) throw new Error(`Truncated load command: ${file}`);
    const command = bytes.readUInt32LE(offset);
    const size = bytes.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > commandsEnd) throw new Error(`Invalid load command: ${file}`);
    if ([0xc, 0x80000018, 0x8000001f, 0x80000023, 0x8000001c].includes(command)) {
      if (size < 12) throw new Error(`Truncated path command: ${file}`);
      const stringOffset = bytes.readUInt32LE(offset + 8);
      const start = offset + stringOffset;
      const end = bytes.indexOf(0, start);
      if (stringOffset < 12 || start >= offset + size || end < start || end >= offset + size) {
        throw new Error(`Invalid load command path: ${file}`);
      }
      const value = bytes.toString("utf8", start, end);
      (command === 0x8000001c ? image.rpaths : image.dependencies).push(value);
    }
    if (command === 0x1d) {
      if (size < 16) throw new Error(`Truncated code signature command: ${file}`);
      image.signature = inspectCodeSignature(bytes, bytes.readUInt32LE(offset + 8), bytes.readUInt32LE(offset + 12), file);
    }
    offset += size;
  }
  return image;
}

function isSystemLibrary(dependency) {
  return dependency.startsWith("/System/Library/") || dependency.startsWith("/usr/lib/");
}

export function verifyMacosBundle(bundlePath) {
  const bundle = path.resolve(bundlePath);
  const contents = path.join(bundle, "Contents");
  const info = readFileSync(path.join(contents, "Info.plist"), "utf8");
  const executableName = info.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!executableName || path.basename(executableName) !== executableName) {
    throw new Error("Info.plist has no valid CFBundleExecutable");
  }
  const executable = path.join(contents, "MacOS", executableName);
  const expectedNative = path.join(contents, "Frameworks", "libxsh-rdp-native.dylib");
  if (!existsSync(expectedNative)) throw new Error(`Missing bundled RDP library: ${expectedNative}`);
  const root = inspectMachO(executable);
  const images = new Map();
  const failures = [];
  const expand = (value, image) => value
    .replace(/^@executable_path(?=\/|$)/, path.dirname(executable))
    .replace(/^@loader_path(?=\/|$)/, path.dirname(image.file));
  const insideBundle = (file) => {
    const relative = path.relative(contents, file);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };

  function visit(file, inheritedRpaths = []) {
    if (images.has(file)) return;
    const image = file === executable ? root : inspectMachO(file);
    images.set(file, image);
    if (image.cpu !== root.cpu) failures.push(`${path.basename(file)} has a different CPU architecture`);
    const rpaths = [
      ...image.rpaths.map((rpath) => expand(rpath, image)),
      ...inheritedRpaths,
    ];
    for (const dependency of image.dependencies) {
      if (isSystemLibrary(dependency)) continue;
      if (dependency.startsWith("/")) {
        failures.push(`${path.basename(file)} requires an unbundled library: ${dependency}`);
        continue;
      }
      const candidates = dependency.startsWith("@rpath/")
        ? rpaths.map((rpath) => path.resolve(rpath, dependency.slice("@rpath/".length)))
        : dependency.startsWith("@loader_path/") || dependency.startsWith("@executable_path/")
          ? [path.resolve(expand(dependency, image))]
          : [];
      const resolved = candidates.find((candidate) => insideBundle(candidate) && existsSync(candidate));
      if (!resolved) {
        failures.push(`${path.basename(file)} cannot resolve ${dependency} within the application`);
      } else {
        visit(resolved, rpaths);
      }
    }
  }

  visit(executable);
  if (!images.has(expectedNative)) failures.push("The executable does not load the bundled RDP library");
  // Check additional packaged dylibs too, including libraries opened with dlopen.
  function checkLibraries(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) checkLibraries(file);
      else if (entry.isFile() && entry.name.endsWith(".dylib")) visit(file, root.rpaths.map((rpath) => expand(rpath, root)));
    }
  }
  checkLibraries(path.join(contents, "Frameworks"));
  // codesign --verify checks signature integrity, but not whether dyld's
  // library validation will permit this executable to load its native library.
  // Ad-hoc personal builds must leave hardened runtime/library validation off.
  const validatesLibraries = root.signature && (root.signature.flags & (0x10000 | 0x2000));
  if (validatesLibraries && (!root.signature.teamId || (root.signature.flags & 2))) {
    failures.push("Executable enables library validation without a certificate signing Team ID; ad-hoc builds must disable hardened runtime");
  }
  for (const image of images.values()) {
    if (!image.signature) {
      failures.push(`${path.basename(image.file)} has no embedded code signature`);
    } else if (validatesLibraries && image !== root
      && (!image.signature.teamId || (image.signature.flags & 2) || image.signature.teamId !== root.signature.teamId)) {
      failures.push(`${path.basename(image.file)} has a different Team ID from the executable and cannot pass library validation`);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
  return { executable: executableName, images: images.size, cpu: root.cpu, signature: root.signature };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error("Usage: node scripts/verify-macos-bundle.mjs <XSH.app>");
    const result = verifyMacosBundle(process.argv[2]);
    console.log(`PASS: ${result.executable} and ${result.images - 1} bundled libraries need only macOS system libraries.`);
    console.log(`PASS: code signing permits the bundled libraries (flags=0x${result.signature.flags.toString(16)}, Team ID=${result.signature.teamId ?? "ad-hoc"}).`);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
