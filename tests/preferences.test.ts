import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  applyPreferences,
  defaultPreferences,
  loadPreferences,
  normalizePreferences,
  savePreferences,
  toSftpTransferPolicy,
} from "../apps/desktop/src/preferences.ts";
import { getTheme, getThemeTokens, THEME_IDS } from "../apps/desktop/src/themes.ts";

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function installDocument() {
  const properties = new Map<string, string>();
  (globalThis as { document?: unknown }).document = {
    documentElement: {
      dataset: {},
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
    },
  };
  return properties;
}

test("migrates legacy v1 preferences with SFTP policy defaults", () => {
  (globalThis as { localStorage?: unknown }).localStorage = createStorage({
    "xsh.preferences.v1": JSON.stringify({ theme: "graphite", terminalFontSize: 16 }),
  });

  const loaded = loadPreferences();

  assert.equal(loaded.theme, "graphite");
  assert.equal(loaded.terminalFontSize, 16);
  assert.equal(loaded.globalSftpTransferConcurrency, 4);
  assert.equal(loaded.perHostSftpTransferConcurrency, 2);
  assert.equal(loaded.sftpUploadBandwidthLimitBps, 0);
  assert.equal(loaded.sftpDownloadBandwidthLimitBps, 0);
});

test("normalizes SFTP concurrency in global then per-host order", () => {
  const normalized = normalizePreferences({
    ...defaultPreferences,
    globalSftpTransferConcurrency: 1.4,
    perHostSftpTransferConcurrency: 31.8,
  });

  assert.equal(normalized.globalSftpTransferConcurrency, 1);
  assert.equal(normalized.perHostSftpTransferConcurrency, 1);

  const fallback = normalizePreferences({
    ...defaultPreferences,
    globalSftpTransferConcurrency: Number.NaN,
    perHostSftpTransferConcurrency: Number.POSITIVE_INFINITY,
  });
  assert.equal(fallback.globalSftpTransferConcurrency, 4);
  assert.equal(fallback.perHostSftpTransferConcurrency, 2);
});

test("normalizes unlimited and bounded aggregate bandwidth values", () => {
  const normalized = normalizePreferences({
    ...defaultPreferences,
    sftpUploadBandwidthLimitBps: 1,
    sftpDownloadBandwidthLimitBps: 2 ** 40,
  });

  assert.equal(normalized.sftpUploadBandwidthLimitBps, 1024);
  assert.equal(normalized.sftpDownloadBandwidthLimitBps, 1024 ** 3);

  const unlimited = normalizePreferences({
    ...defaultPreferences,
    sftpUploadBandwidthLimitBps: -1,
    sftpDownloadBandwidthLimitBps: Number.NaN,
  });
  assert.equal(unlimited.sftpUploadBandwidthLimitBps, 0);
  assert.equal(unlimited.sftpDownloadBandwidthLimitBps, 0);
});

test("maps normalized byte values to the Rust SFTP policy contract", () => {
  const policy = toSftpTransferPolicy({
    ...defaultPreferences,
    globalSftpTransferConcurrency: 8,
    perHostSftpTransferConcurrency: 3,
    sftpUploadBandwidthLimitBps: 12_345_678,
    sftpDownloadBandwidthLimitBps: 87_654_321,
  });

  assert.deepEqual(policy, {
    globalConcurrency: 8,
    perHostConcurrency: 3,
    uploadLimitBytesPerSecond: 12_345_678,
    downloadLimitBytesPerSecond: 87_654_321,
  });
});

test("savePreferences returns and persists the normalized object", () => {
  const storage = createStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  installDocument();

  const saved = savePreferences({
    ...defaultPreferences,
    globalSftpTransferConcurrency: 2.6,
    perHostSftpTransferConcurrency: 9,
    sftpUploadBandwidthLimitBps: 1,
  });

  assert.equal(saved.globalSftpTransferConcurrency, 3);
  assert.equal(saved.perHostSftpTransferConcurrency, 3);
  assert.equal(saved.sftpUploadBandwidthLimitBps, 1024);
  assert.deepEqual(JSON.parse(storage.getItem("xsh.preferences.v1") ?? "null"), saved);
});

test("all old and new theme IDs survive preference persistence", () => {
  for (const theme of THEME_IDS) {
    (globalThis as { localStorage?: unknown }).localStorage = createStorage({
      "xsh.preferences.v1": JSON.stringify({ theme, accent: "green", terminalFontSize: 16 }),
    });
    assert.equal(loadPreferences().theme, theme);
    assert.equal(loadPreferences().accent, "green");
  }
  (globalThis as { localStorage?: unknown }).localStorage = createStorage({
    "xsh.preferences.v1": JSON.stringify({ theme: "removed-theme", accent: "invalid" }),
  });
  assert.equal(loadPreferences().theme, defaultPreferences.theme);
  assert.equal(loadPreferences().accent, defaultPreferences.accent);
});

test("extended themes apply complete palette tokens and clear them when returning to a classic theme", () => {
  const properties = installDocument();
  for (const theme of ["nord", "forest", "sand", "ivory"] as const) {
    applyPreferences({ ...defaultPreferences, theme, accent: "purple" });
    assert.equal(document.documentElement.dataset.theme, theme);
    assert.equal(document.documentElement.dataset.palette, "extended");
    assert.equal(document.documentElement.dataset.scheme, getTheme(theme).scheme);
    for (const [property, value] of Object.entries(getThemeTokens(theme, "purple"))) assert.equal(properties.get(property), value);
  }
  applyPreferences({ ...defaultPreferences, theme: "graphite" });
  assert.equal(document.documentElement.dataset.palette, "classic");
  assert.equal(document.documentElement.dataset.scheme, "dark");
  for (const property of Object.keys(getThemeTokens("graphite"))) assert.equal(properties.get(property), "");
});
