// The two roots src/utils/root.ts resolves, and the policy their kinds carry.
//
// Running under `deno test` is always checkout mode, so the compiled-mode half of
// the contract cannot be asserted in-process. What IS pinned here is everything a
// compiled binary would break if the detection regressed: the on-disk shape of
// PROJECT_ROOT, the paths handed to other programs, and the kind -> protection
// policy every destructive gate reads. Verifying the compiled half means building a
// binary and running it from an install root.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import {
  AGENT_AUTH_GET_ARGS,
  ASSET_ROOT,
  isProtectedRoot,
  looksLikeInstallRoot,
  PROJECT_ROOT,
  PROXY_TOKEN_SCRIPT_SH,
  proxyTokenCommand,
  rootMode,
} from "../src/utils/root.ts";
import { PROJECT_CONFIG_FILE, readProjectConfig } from "../src/utils/project_config.ts";
import { expect, test } from "./helpers/testing.ts";

test("the suite runs in checkout mode, where both roots are the source tree", () => {
  const mode = rootMode();
  expect(mode.kind).toBe("checkout");
  expect(mode.root).toBe(PROJECT_ROOT);
  // Nothing distinguishes the two roots when the code we run and the files we
  // manage are the same directory; a compiled binary is what splits them.
  expect(ASSET_ROOT).toBe(PROJECT_ROOT);
  expect(existsSync(join(PROJECT_ROOT, "package.json"))).toBe(true);
});

test("PROJECT_ROOT is a real absolute directory on disk", () => {
  // The contract compiled mode exists to keep: external programs (codex, claude)
  // are handed paths under this root and must be able to open them.
  expect(isAbsolute(PROJECT_ROOT)).toBe(true);
  expect(existsSync(PROJECT_ROOT)).toBe(true);
  // The resolver script the agent configs point at, per platform. On Windows the argv
  // is `powershell -NoProfile ... -File <script>`, so pick the path off `-File` rather
  // than a fixed index (args[0] there is a flag, which would assert nothing).
  const { args } = proxyTokenCommand();
  const scriptPath = process.platform === "win32" ? args[args.indexOf("-File") + 1] : args[0];
  expect(scriptPath).toBeDefined();
  expect(isAbsolute(String(scriptPath))).toBe(true);
  expect(existsSync(String(scriptPath))).toBe(true);
  if (process.platform !== "win32") expect(scriptPath).toBe(PROXY_TOKEN_SCRIPT_SH);
});

test("protection follows the RootMode kind, with no filesystem probe", () => {
  // A source checkout is protected whether or not it carries a .git dir, and an
  // installed binary root is deletable whether or not it does. The ambient probe
  // this replaced got both backwards in a container and in a non-git copy.
  expect(isProtectedRoot({ kind: "checkout", root: "/nowhere/clone" })).toBe(true);
  expect(isProtectedRoot({ kind: "compiled", root: "/nowhere/install" })).toBe(false);
  expect(isProtectedRoot()).toBe(true); // the ambient mode, under `deno test`
});

test("looksLikeInstallRoot gates the recursive delete on the marker layout", () => {
  // The compiled root is DERIVED (two levels up from the binary), so a binary copied
  // to ~/.local/bin would aim the uninstall rm -rf at ~/.local. Markers, not kind,
  // are what stop that.
  expect(looksLikeInstallRoot(PROJECT_ROOT)).toBe(true);
  expect(looksLikeInstallRoot(homedir())).toBe(false);
  expect(looksLikeInstallRoot(parse(PROJECT_ROOT).root)).toBe(false); // a filesystem root
  const strayBinOnly = join(PROJECT_ROOT, "bin");
  expect(looksLikeInstallRoot(strayBinOnly)).toBe(false); // has no shell/ or src/scripts
});

test("copilot-env.config is read from ASSET_ROOT by default", () => {
  // It is embedded in the compiled binary and never materialized onto disk, so the
  // default root must be the asset root; an install root has no copy to read.
  expect(existsSync(join(ASSET_ROOT, PROJECT_CONFIG_FILE))).toBe(true);
  expect(readProjectConfig().proxyMinVersion).toMatch(/^\d+\.\d+\.\d+/);
  // The default must be ASSET_ROOT specifically, not "whatever root happens to work":
  // a directory with no config must throw rather than silently fall back.
  expect(() => readProjectConfig(join(ASSET_ROOT, "src"))).toThrow();
});

test("the credential resolver argv stays byte-identical", () => {
  // Writers (Codex auth.command, Claude apiKeyHelper) and the health verifier
  // compare these strings; a root refactor must not disturb them.
  expect(AGENT_AUTH_GET_ARGS).toEqual(["auth", "--get"]);
});
