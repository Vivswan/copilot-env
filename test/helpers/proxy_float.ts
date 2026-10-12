// The proxy float's two outside edges as fixtures: the npm registry document the float reads, and
// the `bun install` it runs. A test seeds a registry of versions by publish age and an installer
// that materializes what the manifest names (or fails as told), so a float runs end to end with
// no network and no bun on the path, from a unit of the float up to a whole `agent start`.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROXY_PACKAGE_NAME } from "../../src/copilot_api/version.ts";
import type { FetchLike, InstallRunner } from "../../src/proxy_float.ts";
import { MILLISECONDS_PER_DAY } from "../../src/utils/time.ts";

/** The float's clock in every fixture, so publish ages and record ages agree. */
export const NOW_MS = Date.parse("2026-06-10T00:00:00.000Z");

function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * MILLISECONDS_PER_DAY).toISOString();
}

/** A registry document: each version with its publish age in days before NOW_MS. */
export function registryDoc(
  daysByVersion: Record<string, number>,
  opts: {
    scripts?: Record<string, string[]>;
    hasInstallScript?: string[];
    distTags?: Record<string, string>;
  } = {},
): unknown {
  const versions: Record<string, unknown> = {};
  const time: Record<string, string> = { created: isoDaysAgo(400), modified: isoDaysAgo(0) };
  for (const [version, days] of Object.entries(daysByVersion)) {
    const manifest: Record<string, unknown> = {};
    const scriptNames = opts.scripts?.[version];
    if (scriptNames) {
      manifest.scripts = Object.fromEntries(scriptNames.map((name) => [name, "node evil.js"]));
    }
    if (opts.hasInstallScript?.includes(version)) manifest.hasInstallScript = true;
    versions[version] = manifest;
    time[version] = isoDaysAgo(days);
  }
  return { "dist-tags": opts.distTags ?? {}, versions: versions, time: time };
}

export function docFetch(doc: unknown): { calls: string[]; fetchLike: FetchLike } {
  const calls: string[] = [];
  return {
    calls,
    fetchLike: (url) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify(doc)));
    },
  };
}

export interface InstallCall {
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** What `bun install` leaves in `dir` from the manifest on disk: the proxy package with its
 *  manifest and bin (`entrySource` as the bin's contents, so a launch can run it), every shim
 *  dependency, and the lockfile. */
function materializeInstall(dir: string, entrySource = ""): void {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    const packageDir = join(dir, "node_modules", ...name.split("/"));
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    const proxy = name === PROXY_PACKAGE_NAME;
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name,
        version: proxy ? range : "0.0.0",
        bin: { "copilot-api": "./dist/main.js" },
      }),
    );
    writeFileSync(join(packageDir, "dist", "main.js"), proxy ? entrySource : "");
  }
  writeFileSync(join(dir, "bun.lock"), "{}\n");
}

/** A fake `bun install`: succeeds by materializing whatever the manifest on disk names into the
 *  directory it was run in (the way the real one populates node_modules from package.json), or
 *  fails as told: `exit` every time, `failFirst` the first call alone (the way an outage passes),
 *  `incomplete` reports success but leaves the proxy's entry file out. `entrySource` is what the
 *  proxy's bin holds, for a test that then launches it. */
export function fakeInstall(
  opts: { exit?: number; failFirst?: boolean; incomplete?: boolean; entrySource?: string } = {},
): { calls: InstallCall[]; runner: InstallRunner } {
  const calls: InstallCall[] = [];
  const runner: InstallRunner = (args, options) => {
    calls.push({ args: [...args], cwd: options.cwd, env: options.env });
    if (opts.exit || (opts.failFirst && calls.length === 1)) {
      return { status: opts.exit ?? 1, stderr: "boom" };
    }
    materializeInstall(options.cwd, opts.entrySource);
    if (opts.incomplete) {
      rmSync(
        join(options.cwd, "node_modules", ...PROXY_PACKAGE_NAME.split("/"), "dist", "main.js"),
      );
    }
    return { status: 0, stderr: "" };
  };
  return { calls, runner };
}

export function installCalls(calls: InstallCall[]): InstallCall[] {
  return calls.filter((c) => c.args[0] === "install");
}
