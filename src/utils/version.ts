import pkg from "../../package.json" with { type: "json" };

/** Statically imported so `deno compile` embeds the version. */
export function packageVersion(): string {
  return typeof pkg.version === "string" ? pkg.version : "0.0.0";
}
