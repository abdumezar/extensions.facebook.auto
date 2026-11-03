const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parse(version: string): [number, number, number] | null {
  const match = VERSION.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `candidate` is a strictly higher `x.y.z` than `current`; malformed input is never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}
