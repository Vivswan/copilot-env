import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { configureCodexConfig } from "../src/codex/config.ts";
import {
  CI_NO_LIVE_LOOKUPS_ENV,
  FALLBACK_CODEX_UA_VERSION,
  resetCodexVersionMemo,
} from "../src/codex/user_agent.ts";
import { afterEach, expect, removeDir, test } from "./helpers/testing.ts";
import { envSnapshot, isolateAgentHomes } from "./helpers.ts";

const restoreEnv = envSnapshot(["PATH", CI_NO_LIVE_LOOKUPS_ENV]);
let dir = "";
// The default credential shape: the config names a copilot-env command that prints the credential.
const COMMAND = { kind: "command" } as const;

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function isolate(): void {
  dir = isolateAgentHomes("copilot-codex-ua-", { mkdirs: true }).dir;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

// The live-lookup seam is OFF here, so the real `codex --version` and `npm view` roads run, against
// fakes that shadow any real codex or npm (the fake bin dir leads PATH in every arm, an exit-1 fake
// included; /usr/bin and /bin stay for `sh`).
test.skipIf(process.platform === "win32")(
  "Direct UA version chain: installed codex, else npm's release, else the baked fallback; one spawn per road per process, failures included",
  () => {
    isolate();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const spawns = join(dir, "spawns");
    const fake = (command: string, output: string | null): void => {
      const answer = output === null ? "exit 1" : `echo '${output}'`;
      writeFileSync(join(bin, command), `#!/bin/sh\necho ${command} >> "${spawns}"\n${answer}\n`);
      chmodSync(join(bin, command), 0o755);
    };
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    delete process.env[CI_NO_LIVE_LOOKUPS_ENV];
    const codexHome = join(dir, ".codex");
    const userAgent = (): unknown => {
      configureCodexConfig(codexHome, { mode: "direct", credential: COMMAND });
      const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
      return asRecord(asRecord(asRecord(doc.model_providers)["copilot-env"]).http_headers)[
        "User-Agent"
      ];
    };
    // Two writes per arm: the second must reuse the memo, a memoized failure included.
    const arm = (
      codex: string | null,
      npm: string | null,
    ): { agent: unknown; spawned: string[] } => {
      resetCodexVersionMemo();
      rmSync(spawns, { force: true });
      fake("codex", codex);
      fake("npm", npm);
      const agent = userAgent();
      expect(userAgent()).toBe(agent);
      return { agent, spawned: readFileSync(spawns, "utf8").trim().split("\n") };
    };

    expect(arm("codex-cli 9.9.9", "8.8.8")).toEqual({
      agent: "codex_exec/9.9.9", // the installed codex wins; npm is never asked
      spawned: ["codex"],
    });
    expect(arm(null, "8.8.8")).toEqual({
      agent: "codex_exec/8.8.8", // no codex: npm's current release
      spawned: ["codex", "npm"],
    });
    expect(arm(null, null)).toEqual({
      agent: `codex_exec/${FALLBACK_CODEX_UA_VERSION}`, // offline: the fallback
      spawned: ["codex", "npm"],
    });
    // Copilot rejects some models for a version-LESS codex_exec UA (the gate is the versioned
    // SHAPE), so the fallback must stay a real X.Y.Z release.
    expect(FALLBACK_CODEX_UA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  },
);
