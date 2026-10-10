// One platform probe for the whole app; duplicated regexes drifted between
// files (navigator.platform only, vs platform + userAgent).
export function isMacOS(): boolean {
  return /mac|iphone|ipad/i.test(`${navigator.platform} ${navigator.userAgent}`);
}

export const IS_MACOS = isMacOS();
