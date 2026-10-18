import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { configureCodexConfig } from "../../src/codex/config.ts";
import {
  CI_NO_LIVE_LOOKUPS_ENV,
  codexUserAgent,
  FALLBACK_CODEX_UA_VERSION,
  resetCodexVersionMemo,
} from "../../src/codex/user_agent.ts";
import { withNarrationMuted } from "../../src/utils/logger.ts";
import { envSnapshot, isolateAgentHomes } from "../helpers/env.ts";
import { captureChannels } from "../helpers/output.ts";
import { afterEach, expect, test } from "../helpers/testing.ts";

const restoreEnv = envSnapshot(["PATH", CI_NO_LIVE_LOOKUPS_ENV]);
let dir = "";
// The default credential shape: the config names a copilot-env command that prints the credential.
const COMMAND = { kind: "command" } as const;

afterEach(() => {
  restoreEnv();
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

// The live-lookup seam is OFF here, so the real `codex --version` road runs, against a fake that
// shadows any real codex (the fake bin dir leads PATH in every arm, an exit-1 fake included;
// /usr/bin and /bin stay for `sh`).
test.skipIf(process.platform === "win32")(
  "Direct UA version chain: the installed codex, else the baked fallback; one spawn per process, a failure included",
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
      configureCodexConfig(codexHome, { mode: "direct", direct: null, credential: COMMAND });
      const doc = asRecord(parse(readFileSync(join(codexHome, "config.toml"), "utf8")));
      return asRecord(asRecord(asRecord(doc.model_providers)["copilot-env"]).http_headers)[
        "User-Agent"
      ];
    };
    // Two writes per arm: the second must reuse the memo, a memoized failure included.
    const arm = (codex: string | null): { agent: unknown; spawned: string[] } => {
      resetCodexVersionMemo();
      rmSync(spawns, { force: true });
      fake("codex", codex);
      const agent = userAgent();
      expect(userAgent()).toBe(agent);
      return { agent, spawned: readFileSync(spawns, "utf8").trim().split("\n") };
    };

    expect(arm("codex-cli 9.9.9")).toEqual({
      agent: "codex_exec/9.9.9",
      spawned: ["codex"],
    });
    expect(arm(null)).toEqual({
      agent: `codex_exec/${FALLBACK_CODEX_UA_VERSION}`,
      spawned: ["codex"],
    });
    // Copilot rejects some models for a version-LESS codex_exec UA (the gate is the versioned
    // SHAPE), so the fallback must stay a real X.Y.Z release.
    expect(FALLBACK_CODEX_UA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  },
);

// On Windows an npm install leaves a `codex.cmd` shim, which a direct spawn turns into a bare
// EINVAL read as "no codex". A muted call is an import's preview.
test.skipIf(process.platform !== "win32")(
  "Direct UA version chain (Windows): an npm codex.cmd shim on PATH is never spawned; the fallback goes out, and the note is said once, by the first unmuted call",
  async () => {
    isolate();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const ran = join(dir, "ran.txt");
    writeFileSync(
      join(bin, "codex.cmd"),
      `@echo off\r\necho ran > "${ran}"\r\necho codex-cli 9.9.9\r\n`,
    );
    process.env.PATH = `${bin};${process.env.PATH ?? ""}`;
    delete process.env[CI_NO_LIVE_LOOKUPS_ENV];
    resetCodexVersionMemo();
    const note = `${join(bin, "codex.cmd")} is an npm-installed copy of codex this build cannot run`;
    const count = (text: string): number => text.split(note).length - 1;
    const muted = await captureChannels(() =>
      withNarrationMuted(async () => {
        codexUserAgent();
      }),
    );
    expect(count(muted.stderr)).toBe(0);
    let agent = "";
    const { stderr } = await captureChannels(() => {
      agent = codexUserAgent();
      codexUserAgent();
    });
    expect(agent).toBe(`codex_exec/${FALLBACK_CODEX_UA_VERSION}`);
    expect(count(stderr)).toBe(1);
    expect(stderr).toContain("npm uninstall -g @openai/codex");
    expect(readFileSync(ran, { encoding: "utf8", flag: "a+" })).toBe("");
  },
);
