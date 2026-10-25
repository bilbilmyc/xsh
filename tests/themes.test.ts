import assert from "node:assert/strict";
import test from "node:test";
import { getTheme, getThemeTokens, resolveTerminalTheme, terminal256ColorPalette, TERMINAL_THEMES, THEME_IDS, THEMES, type ThemeAccent } from "../apps/desktop/src/themes.ts";

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("all eight themes provide complete semantic tokens and ANSI colors", () => {
  assert.equal(THEMES.length, 8);
  assert.deepEqual(THEMES.map((theme) => theme.value), THEME_IDS);
  const expectedKeys = Object.keys(getThemeTokens("nord")).sort();
  for (const theme of THEMES) {
    assert.deepEqual(Object.keys(getThemeTokens(theme.value)).sort(), expectedKeys, theme.value);
    for (const value of Object.values(getThemeTokens(theme.value))) assert.match(value, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
    assert.equal(Object.keys(theme.terminal).length, 21);
    for (const value of Object.values(theme.terminal)) assert.match(value, /^#[0-9a-f]{6}$/i);
  }
});

test("new themes give normal, secondary and accent text AA contrast across their surfaces", () => {
  const accents: ThemeAccent[] = ["cyan", "blue", "green", "orange", "purple"];
  for (const theme of THEMES.filter((entry) => entry.extended)) {
    for (const accent of accents) {
      const tokens = getThemeTokens(theme.value, accent);
      for (const surface of ["--bg", "--panel", "--panel-raised", "--chrome", "--chrome-raised", "--panel-hover"]) {
        for (const foreground of ["--text", "--text-strong", "--muted", "--faint", "--accent"]) {
          assert.ok(contrast(tokens[foreground], tokens[surface]) >= 4.5, `${theme.value}/${accent} ${foreground} on ${surface}`);
        }
      }
      assert.ok(contrast(tokens["--accent-contrast"], tokens["--accent"]) >= 4.5, `${theme.value}/${accent} primary button`);
    }
    assert.ok(contrast(theme.terminal.foreground, theme.terminal.background) >= 7, `${theme.value} terminal text`);
    for (const color of ["red", "green", "yellow", "blue", "magenta", "cyan"] as const) {
      assert.ok(contrast(theme.terminal[color], theme.terminal.background) >= 4.5, `${theme.value} ANSI ${color}`);
    }
  }
});

test("new themes change surfaces and terminal palettes rather than only accent colors", () => {
  const extended = THEMES.filter((theme) => theme.extended);
  assert.equal(extended.filter((theme) => theme.scheme === "light").length, 2);
  assert.equal(new Set(extended.map((theme) => theme.colors.background)).size, 4);
  assert.equal(new Set(extended.map((theme) => theme.colors.chrome)).size, 4);
  assert.equal(new Set(extended.map((theme) => theme.terminal.selectionBackground)).size, 4);
  assert.equal(new Set(extended.map((theme) => theme.terminal.green)).size, 4);
});

test("global terminal themes follow the app while explicit session themes keep priority", () => {
  const blue = resolveTerminalTheme("xsh-blue", "midnight");
  const green = resolveTerminalTheme("xsh-green", "midnight");
  assert.equal(blue.background, "#07111f");
  assert.equal(green.background, "#07130b");
  for (const theme of THEMES) {
    for (const profileTheme of ["xsh-dark", "midnight", "graphite", "dusk", "light", "xsh-light", "unknown", ""]) {
      assert.deepEqual(resolveTerminalTheme(profileTheme, theme.value), theme.terminal, `${profileTheme} follows ${theme.value}`);
    }
    assert.deepEqual(resolveTerminalTheme("xsh-blue", theme.value), blue);
    assert.deepEqual(resolveTerminalTheme("xsh-green", theme.value), green);
  }
  assert.deepEqual(resolveTerminalTheme("unknown", "nord"), getTheme("nord").terminal);
});

test("terminal colors follow session, global terminal, then app preferences", () => {
  for (const appTheme of THEME_IDS) {
    for (const globalTheme of TERMINAL_THEMES) {
      for (const inherited of ["xsh-dark", "", "unknown", "midnight"]) {
        assert.deepEqual(resolveTerminalTheme(inherited, appTheme, globalTheme.value), globalTheme.palette);
      }
      for (const sessionTheme of TERMINAL_THEMES) {
        assert.deepEqual(resolveTerminalTheme(sessionTheme.value, appTheme, globalTheme.value), sessionTheme.palette);
      }
    }
    assert.deepEqual(resolveTerminalTheme("xsh-dark", appTheme, "xsh-dark"), getTheme(appTheme).terminal);
  }
});

test("each terminal background has readable text and a full ANSI palette", () => {
  assert.equal(TERMINAL_THEMES.length, 12);
  assert.equal(new Set(TERMINAL_THEMES.map((theme) => theme.palette.background)).size, 12);
  const keys = Object.keys(getTheme("midnight").terminal).sort();
  for (const theme of TERMINAL_THEMES) {
    assert.deepEqual(Object.keys(theme.palette).sort(), keys, theme.value);
    assert.ok(contrast(theme.palette.foreground, theme.palette.background) >= 7, `${theme.value} terminal text`);
  }
});

test("all terminal palettes retain the standard xterm 256-color cube and grayscale", () => {
  let extended: string[] | undefined;
  for (const theme of TERMINAL_THEMES) {
    const colors = terminal256ColorPalette(theme.palette);
    assert.equal(colors.length, 256, theme.value);
    assert.deepEqual(colors.slice(0, 8), [
      theme.palette.black, theme.palette.red, theme.palette.green, theme.palette.yellow,
      theme.palette.blue, theme.palette.magenta, theme.palette.cyan, theme.palette.white,
    ]);
    assert.equal(colors[16], "#000000");
    assert.equal(colors[21], "#0000ff");
    assert.equal(colors[46], "#00ff00");
    assert.equal(colors[196], "#ff0000");
    assert.equal(colors[231], "#ffffff");
    assert.equal(colors[232], "#080808");
    assert.equal(colors[255], "#eeeeee");
    if (extended) assert.deepEqual(colors.slice(16), extended);
    extended = colors.slice(16);
    // Leaving extendedAnsi unset lets xterm handle indexed color sequences.
    assert.equal("extendedAnsi" in theme.palette, false);
  }
});
