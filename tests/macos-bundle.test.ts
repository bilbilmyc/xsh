import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyMacosBundle } from "../scripts/verify-macos-bundle.mjs";

type Signing = { flags: number; teamId?: string };

function machO(dependencies: string[], rpaths: string[] = [], signing: Signing = { flags: 2 }) {
  const commands = [
    ...dependencies.map((name) => ({ command: 0xc, name, header: 24 })),
    ...rpaths.map((name) => ({ command: 0x8000001c, name, header: 12 })),
  ].map(({ command, name, header }) => {
    const bytes = Buffer.alloc(Math.ceil((header + Buffer.byteLength(name) + 1) / 8) * 8);
    bytes.writeUInt32LE(command, 0);
    bytes.writeUInt32LE(bytes.length, 4);
    bytes.writeUInt32LE(header, 8);
    bytes.write(name, header);
    return bytes;
  });
  const identifier = Buffer.from("com.xsh.fixture\0");
  const teamId = signing.teamId ? Buffer.from(`${signing.teamId}\0`) : Buffer.alloc(0);
  const codeDirectory = Buffer.alloc(52 + identifier.length + teamId.length);
  codeDirectory.writeUInt32BE(0xfade0c02, 0);
  codeDirectory.writeUInt32BE(codeDirectory.length, 4);
  codeDirectory.writeUInt32BE(0x20200, 8);
  codeDirectory.writeUInt32BE(signing.flags, 12);
  codeDirectory.writeUInt32BE(52, 20);
  if (teamId.length) codeDirectory.writeUInt32BE(52 + identifier.length, 48);
  identifier.copy(codeDirectory, 52);
  teamId.copy(codeDirectory, 52 + identifier.length);
  const superblob = Buffer.alloc(20 + codeDirectory.length);
  superblob.writeUInt32BE(0xfade0cc0, 0);
  superblob.writeUInt32BE(superblob.length, 4);
  superblob.writeUInt32BE(1, 8);
  superblob.writeUInt32BE(20, 16);
  codeDirectory.copy(superblob, 20);
  const signatureCommand = Buffer.alloc(16);
  signatureCommand.writeUInt32LE(0x1d, 0);
  signatureCommand.writeUInt32LE(16, 4);
  signatureCommand.writeUInt32LE(32 + commands.reduce((size, command) => size + command.length, 0) + 16, 8);
  signatureCommand.writeUInt32LE(superblob.length, 12);
  commands.push(signatureCommand);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x100000c, 4);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(commands.reduce((size, command) => size + command.length, 0), 20);
  return Buffer.concat([header, ...commands, superblob]);
}

function bundleFixture(
  t: test.TestContext,
  nativeDependencies: string[],
  rpaths = ["@executable_path/../Frameworks"],
  signing: { executable?: Signing; native?: Signing } = {},
) {
  const temporaryRoot = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(temporaryRoot, "xsh-macos-bundle-"));
  t.after(() => {
    assert.equal(path.dirname(directory), temporaryRoot);
    assert.ok(path.basename(directory).startsWith("xsh-macos-bundle-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const bundle = path.join(directory, "XSH.app");
  const contents = path.join(bundle, "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  mkdirSync(path.join(contents, "Frameworks"), { recursive: true });
  writeFileSync(path.join(contents, "Info.plist"), "<plist><dict><key>CFBundleExecutable</key><string>desktop</string></dict></plist>");
  writeFileSync(path.join(contents, "MacOS", "desktop"), machO(["@rpath/libxsh-rdp-native.dylib"], rpaths, signing.executable));
  writeFileSync(path.join(contents, "Frameworks", "libxsh-rdp-native.dylib"), machO(nativeDependencies, [], signing.native));
  return bundle;
}

test("published macOS bundles reject a transitive Homebrew dependency before release", (t) => {
  const bundle = bundleFixture(t, ["/usr/lib/libSystem.B.dylib", "/opt/homebrew/opt/json-c/lib/libjson-c.5.dylib"]);
  assert.throws(() => verifyMacosBundle(bundle), /libxsh-rdp-native\.dylib requires an unbundled library: \/opt\/homebrew\/opt\/json-c/);
});

test("macOS bundles resolve their native library from Frameworks after relocation", (t) => {
  const bundle = bundleFixture(t, ["/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/Carbon.framework/Versions/A/Carbon"]);
  assert.equal(verifyMacosBundle(bundle).images, 2);
});

test("having a native library in the bundle is insufficient without a working rpath", (t) => {
  const bundle = bundleFixture(t, ["/usr/lib/libSystem.B.dylib"], ["@loader_path"]);
  assert.throws(() => verifyMacosBundle(bundle), /cannot resolve @rpath\/libxsh-rdp-native\.dylib/);
});

test("ad-hoc hardened executables cannot load the bundled RDP library without a signing team", (t) => {
  const bundle = bundleFixture(t, ["/usr/lib/libSystem.B.dylib"], undefined, { executable: { flags: 0x10002 } });
  assert.throws(() => verifyMacosBundle(bundle), /library validation.*Team ID/i);
});

test("hardened executables reject a bundled native library signed by a different team", (t) => {
  const bundle = bundleFixture(t, ["/usr/lib/libSystem.B.dylib"], undefined, {
    executable: { flags: 0x10000, teamId: "XSHAPPTEAM" },
    native: { flags: 0, teamId: "OTHERTEAM" },
  });
  assert.throws(() => verifyMacosBundle(bundle), /different Team ID/i);
});

test("hardened executables can load a native library signed by the same team", (t) => {
  const bundle = bundleFixture(t, ["/usr/lib/libSystem.B.dylib"], undefined, {
    executable: { flags: 0x10000, teamId: "XSHAPPTEAM" },
    native: { flags: 0, teamId: "XSHAPPTEAM" },
  });
  assert.equal(verifyMacosBundle(bundle).images, 2);
});
