import pkg from "../../package.json" with { type: "json" };

/** Statically imported so the compile step embeds the manifest in the binary. */
export function packageVersion(): string {
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}

/** `dependencies` alone: the proxy daemon's import map (src/proxy_float.ts) is rendered from these
 *  ranges, so a package the preload shims import at run time must be a runtime dependency. */
export function packageDependencies(): Record<string, string> {
  // The import is typed from the manifest's current text; the read is of the field by name.
  const manifest = pkg as unknown as { dependencies?: Record<string, string> };
  return { ...manifest.dependencies };
}
