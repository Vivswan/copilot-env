// Deno lint plugin: the secret-carrying daemon preload shims must stay free of
// runtime imports. A `--preload` shim runs inside the proxy daemon, and pulling
// a CLI module in with it would drag the whole CLI layer into that process --
// which is why each shim re-declares its env-key/header contracts as local
// literals (pinned against the CLI constants by test/daemon_env_keys.test.ts).
//
// The rule is registered in deno.json so `deno lint` enforces it repo-wide, and
// unit-tested via Deno.lint.runPlugin in test/daemon_env_keys.test.ts. It scopes
// itself to SHIM_FILES and no-ops everywhere else; type-only imports are erased
// at runtime and stay allowed.

/** The shims the rule guards, relative to the repo root. */
export const SHIM_FILES = [
  "src/scripts/token_argv_preload.ts",
  "src/scripts/pat_passthrough_preload.ts",
] as const;

function isShimFile(filename: string): boolean {
  const normalized = filename.replaceAll("\\", "/");
  return SHIM_FILES.some((shim) => normalized === shim || normalized.endsWith(`/${shim}`));
}

const WHY =
  "preload shims stay import-free (a runtime import would drag CLI modules into the daemon process; see test/daemon_env_keys.test.ts)";

const plugin: Deno.lint.Plugin = {
  name: "copilot-env",
  rules: {
    "no-shim-imports": {
      create(context) {
        if (!isShimFile(context.filename)) return {};
        return {
          "ImportDeclaration"(node) {
            if (node.importKind === "type") return;
            context.report({ node, message: `static import: ${WHY}` });
          },
          "ExportAllDeclaration"(node) {
            context.report({ node, message: `re-export: ${WHY}` });
          },
          "ExportNamedDeclaration"(node) {
            if (node.source === null || node.exportKind === "type") return;
            context.report({ node, message: `re-export: ${WHY}` });
          },
          "ImportExpression"(node) {
            context.report({ node, message: `dynamic import(): ${WHY}` });
          },
          // The bare identifier, not a call shape: aliasing or `require?.()`
          // would evade a call-shaped pattern. A property named `require`
          // false-positives loudly -- preferable to a silent miss, and no shim
          // comes close.
          "Identifier"(node) {
            if (node.name === "require") context.report({ node, message: `require: ${WHY}` });
          },
        };
      },
    },
  },
};

export default plugin;
