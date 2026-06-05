// Resolve the newest STABLE npm release that has been public for at least N days.
//
// Single source of truth for the install.sh / install.ps1 supply-chain cooldown.
// Both installers pipe `npm view <pkg> time --json` -- a { version: ISO-publish-
// timestamp } map, plus "created"/"modified" bookkeeping keys -- into this script
// with `--days N`, and it prints the newest plain x.y.z release (no prereleases)
// that is at least N days old. Keeping the logic here, rather than inline in each
// installer, means one implementation and one test suite, so the POSIX and Windows
// installers (which must stay feature-matched) can never drift. It is run with bun
// -- already installed before the cooldown resolves in both installers:
//   npm view <pkg> time --json | bun src/install/aged-version.ts --days 7
// Exit: 0 + version on stdout; 2 bad args; 3 unparseable/empty stdin; 4 none old enough.

const STABLE = /^\d+\.\d+\.\d+$/; // plain x.y.z -- excludes prereleases + created/modified

// Pure + deterministic (now is injected, not read from the clock) so it is
// directly unit-testable. Returns the newest qualifying version, or null.
export function pickAgedVersion(
  timeMap: Record<string, string>,
  days: number,
  nowMs: number,
): string | null {
  const cutoff = nowMs - days * 86_400_000;
  let best: [number, number, number] | null = null;
  for (const [version, iso] of Object.entries(timeMap)) {
    if (!STABLE.test(version)) continue;
    const published = Date.parse(iso);
    if (Number.isNaN(published) || published > cutoff) continue;
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    const parts: [number, number, number] = [major, minor, patch];
    if (best === null || compareCore(parts, best) > 0) best = parts;
  }
  return best === null ? null : best.join(".");
}

// Numeric (not lexical) compare so 1.2.10 > 1.2.9 and 1.10.0 > 1.9.9.
function compareCore(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--days");
  const days = flag === -1 ? Number.NaN : Number(args[flag + 1]);
  if (!Number.isInteger(days) || days < 0) {
    process.stderr.write("usage: aged-version.ts --days <non-negative int>  (JSON on stdin)\n");
    process.exit(2);
  }

  const raw = await Bun.stdin.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.exit(3);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) process.exit(3);

  const version = pickAgedVersion(parsed as Record<string, string>, days, Date.now());
  if (version === null) process.exit(4);
  process.stdout.write(`${version}\n`);
}

if (import.meta.main) {
  await main();
}
