import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import {
  closeGateFromScan,
  installedState,
  installGateFromScan,
  postPairingCloseFromScan,
  QUIT_TIMEOUT_MS,
  quitApp,
  readTopLevelString,
  restoreModelProvider,
  runningState,
  stripModelProvider,
} from "../src/codex/mobile.ts";
import { appScanFromExit, appScanVerdict } from "../src/utils/app_scan.ts";
import { expect, tempDir, test } from "./helpers/testing.ts";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

const CONFIG = [
  'model_provider = "copilot-env"',
  'web_search = "live"',
  "",
  "[my_custom]",
  'keep = "me"',
  "",
  "[model_providers.copilot-env]",
  'base_url = "http://localhost:4141/v1"',
  'env_key = "OPENAI_API_KEY"',
  "requires_openai_auth = true",
  "",
  "[model_providers.other]",
  'base_url = "https://api.githubcopilot.com"',
  "",
].join("\n");

const readModelProvider = (toml: string) => readTopLevelString(toml, "model_provider");
const readModelCatalogJson = (toml: string) => readTopLevelString(toml, "model_catalog_json");

test("readTopLevelString returns the configured top-level string, null when absent, not a string, or malformed", () => {
  expect(readModelProvider(CONFIG)).toBe("copilot-env");
  expect(readModelProvider('web_search = "live"\n')).toBe(null);
  expect(readTopLevelString("model_provider = 3\n", "model_provider")).toBe(null);
  expect(readModelProvider("{ not toml")).toBe(null);
});

test("stripModelProvider removes model_provider, forces requires_openai_auth=false, keeps the rest", () => {
  const doc = asRecord(parse(stripModelProvider(CONFIG)));
  expect(doc.model_provider).toBeUndefined();
  expect(doc.web_search).toBe("live");
  expect(asRecord(doc.my_custom).keep).toBe("me");
  const providers = asRecord(doc.model_providers);
  expect(asRecord(providers["copilot-env"]).requires_openai_auth).toBe(false);
  expect(asRecord(providers["copilot-env"]).base_url).toBe("http://localhost:4141/v1");
  expect(asRecord(providers.other).base_url).toBe("https://api.githubcopilot.com");
});

test("restoreModelProvider puts the provider back and round-trips through strip", () => {
  const stripped = stripModelProvider(CONFIG);
  expect(readModelProvider(stripped)).toBe(null);
  const restored = restoreModelProvider(stripped, "copilot-env");
  expect(readModelProvider(restored)).toBe("copilot-env");
  const doc = asRecord(parse(restored));
  expect(asRecord(asRecord(doc.model_providers)["copilot-env"]).requires_openai_auth).toBe(false);
});

test("strip removes model_catalog_json; restore puts it back only when captured", () => {
  // Top-level keys must precede any [table] in TOML, so prepend.
  const config =
    `model_catalog_json = "/home/u/.local/share/copilot-api/codex-model-catalog.json"\n${CONFIG}`;
  expect(readModelCatalogJson(config)).toBe(
    "/home/u/.local/share/copilot-api/codex-model-catalog.json",
  );

  // Stripped alongside model_provider: pairing runs the real OpenAI provider,
  // whose limits the Copilot-patched catalog would misstate.
  const stripped = stripModelProvider(config);
  expect(readModelCatalogJson(stripped)).toBe(null);

  const restored = restoreModelProvider(
    stripped,
    "copilot-env",
    "/home/u/.local/share/copilot-api/codex-model-catalog.json",
  );
  expect(readModelCatalogJson(restored)).toBe(
    "/home/u/.local/share/copilot-api/codex-model-catalog.json",
  );

  const neverHad = restoreModelProvider(stripModelProvider(CONFIG), "copilot-env", null);
  expect(readModelCatalogJson(neverHad)).toBe(null);
});

// --- the three-state app scans and their gates --------------------------------

test("closeGateFromScan: proven absence proceeds silently; present and unproven take the gate", () => {
  expect(closeGateFromScan("absent")).toEqual({ close: false });

  expect(closeGateFromScan("present")).toEqual({
    close: true,
    warn: null,
    prompt: "The Codex app is open. Close it now?",
  });

  // A failed look takes the same gate, never the silent proceed that would swap config under
  // a possibly-open app; the prompt says "possibly open", never "is open".
  expect(closeGateFromScan("unproven")).toEqual({
    close: true,
    warn: "The process scan failed, so it could not prove the Codex app is closed.",
    prompt: "Treat the Codex app as possibly open and close it now?",
  });
});

test("appScanFromExit: only an UNMARKED exit 1 is the proven absence", () => {
  expect(appScanFromExit({ exitCode: 0 })).toBe("present");
  expect(appScanFromExit({ exitCode: 1 })).toBe("absent"); // the tool RAN and found nothing
  // runCaptured synthesizes the SAME exit 1 for a look that never ran; the
  // launch-failure mark is what keeps it from reading as a proven absence.
  expect(appScanFromExit({ exitCode: 1, launchFailed: true })).toBe("unproven");
  expect(appScanFromExit({ exitCode: 3 })).toBe("unproven"); // the tool's own hard error
});

test("appScanVerdict: a verdict word only counts with exit 0 (killed-after-speaking)", () => {
  expect(appScanVerdict({ exitCode: 0, stdout: "present\n" })).toBe("present");
  expect(appScanVerdict({ exitCode: 0, stdout: "absent" })).toBe("absent");
  // A scan killed AFTER printing its verdict (a timeout kill, OOM, an interrupt)
  // exits nonzero with a valid word already on stdout: the exit-0 guard is the
  // sole protection against that look minting a proven reading.
  expect(appScanVerdict({ exitCode: 1, stdout: "present\n" })).toBe("unproven");
  expect(appScanVerdict({ exitCode: 1, stdout: "absent\n" })).toBe("unproven");
  // A clean exit without a verdict word proves nothing either.
  expect(appScanVerdict({ exitCode: 0, stdout: "garbled" })).toBe("unproven");
  expect(appScanVerdict({ exitCode: 0, stdout: "" })).toBe("unproven");
});

test("installGateFromScan: present proceeds; proven absence aborts; unproven asks", () => {
  expect(installGateFromScan("present")).toEqual({ kind: "proceed" });
  expect(installGateFromScan("absent")).toEqual({
    kind: "abort",
    warn: "The Codex app does not appear to be installed.",
    info: "Install the Codex app, then re-run `agent codex-mobile`.",
  });
  // A failed look is NOT "not installed": it asks the user, never the false abort.
  expect(installGateFromScan("unproven")).toEqual({
    kind: "confirm",
    warn: "The install scan failed, so it could not check whether the Codex app is installed.",
    prompt: "Continue with pairing anyway?",
  });
});

test("postPairingCloseFromScan: only PROVEN-present quits; unproven warns, never quits", () => {
  expect(postPairingCloseFromScan("present")).toEqual({ quit: true, warn: null });
  expect(postPairingCloseFromScan("absent")).toEqual({ quit: false, warn: null });
  // The failed look does not escalate into quit(); the warn stays, so restore proceeds knowingly.
  expect(postPairingCloseFromScan("unproven")).toEqual({
    quit: false,
    warn: "The process scan failed, so it could not prove the Codex app is closed.",
  });
});

// pgrep/open/osascript/pkill are the POSIX primitives; a PATH pinned to a dir holding ONLY the
// fakes means the real tools can never answer for one, and a removed fake is a REAL spawn failure.
const onPosix = test.skipIf(process.platform === "win32");

function fakeTools(): {
  dir: string;
  fake: (tool: string, body: string) => void;
  restore: () => void;
} {
  const dir = tempDir("codex-mobile-scan-");
  const originalPath = process.env.PATH;
  process.env.PATH = dir;
  return {
    dir,
    fake: (tool, body) =>
      writeFileSync(join(dir, tool), `#!/bin/sh\nPATH=/usr/bin:/bin\n${body}\n`, { mode: 0o755 }),
    restore: () => {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

onPosix(
  "the real POSIX scans three-state pgrep/open: 0 present, 1 proven absent, else unproven",
  async () => {
    const tools = fakeTools();
    try {
      for (const [exit, want] of [[0, "present"], [1, "absent"], [3, "unproven"]] as const) {
        tools.fake("pgrep", `exit ${exit}`);
        expect(await runningState()).toBe(want);
        tools.fake("open", `exit ${exit}`);
        expect(await installedState()).toBe(want);
      }
      // The spawn-failure arm: runCaptured coerces ENOENT to exit 1 WITH the mark --
      // never pgrep's own proven-absent exit 1.
      rmSync(join(tools.dir, "pgrep"));
      expect(await runningState()).toBe("unproven");
    } finally {
      tools.restore();
    }
  },
);

/** A quitApp run over fake tools: `pgrep` answers `exits` in order (the last one repeats) and every
 *  call is journaled; `osascript` and `pkill` leave markers. */
async function quitOver(
  exits: number[],
): Promise<{ polls: number; asked: boolean; killed: boolean }> {
  const tools = fakeTools();
  try {
    const asked = join(tools.dir, "asked");
    const polls = join(tools.dir, "polls");
    const killed = join(tools.dir, "killed");
    tools.fake("osascript", `touch "${asked}"`);
    tools.fake("pkill", `touch "${killed}"`);
    tools.fake(
      "pgrep",
      [
        `echo poll >> "${polls}"`,
        `n=$(wc -l < "${polls}")`,
        ...exits.map((exit, i) => `[ "$n" -eq ${i + 1} ] && exit ${exit}`),
        `exit ${exits.at(-1)}`,
      ].join("\n"),
    );
    await quitApp();
    const count = existsSync(polls) ? readFileSync(polls, "utf8").trim().split("\n").length : 0;
    return { polls: count, asked: existsSync(asked), killed: existsSync(killed) };
  } finally {
    tools.restore();
  }
}

onPosix(
  "quitApp asks the app to quit and polls until a PROVEN absence: one that left on its own is never force-quit",
  async () => {
    // Still running on the first poll, gone on the second: exactly two polls, then the return.
    expect(await quitOver([0, 1])).toEqual({ polls: 2, asked: true, killed: false });
  },
);

// Rides the whole quit deadline (8s): the fact under test is what happens when the wait runs out.
onPosix(
  "quitApp force-quits at the deadline when no poll ever PROVES the app absent: an unproven look keeps polling, never ends the wait",
  async () => {
    const run = await quitOver([3]);
    expect(run.killed).toBe(true);
    expect(run.polls).toBeGreaterThan(1);
  },
);

// Drives real Windows PowerShell.
test.skipIf(process.platform !== "win32")(
  "the real Windows scans mint a verdict word on a healthy host, and a quit with no app running ends on the proven absence",
  async () => {
    // The completeness control: on a healthy host the scripts must RUN and mint a
    // verdict word -- a PowerShell-5.1-incompatible script or a wrong no-match
    // discriminant would read "unproven" here and go red.
    expect(["present", "absent"]).toContain(await runningState());
    expect(["present", "absent"]).toContain(await installedState());
    // No app of that name runs on a CI host: the graceful-quit script runs, the first poll proves
    // the absence, and the call returns well inside the force-quit deadline (an unproven look
    // would ride the whole deadline instead).
    const started = Date.now();
    await quitApp();
    expect(Date.now() - started).toBeLessThan(QUIT_TIMEOUT_MS);
  },
);
