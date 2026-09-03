import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import {
  appScanFromExit,
  closeGateFromScan,
  CodexAppController,
  installGateFromScan,
  postPairingCloseFromScan,
  readModelCatalogJson,
  readModelProvider,
  restoreModelProvider,
  stripModelProvider,
} from "../src/codex/mobile.ts";
import { expect, test } from "./helpers/testing.ts";

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

test("readModelProvider returns the configured provider, null when absent/malformed", () => {
  expect(readModelProvider(CONFIG)).toBe("copilot-env");
  expect(readModelProvider('web_search = "live"\n')).toBe(null);
  expect(readModelProvider("{ not toml")).toBe(null);
});

test("stripModelProvider removes model_provider, forces requires_openai_auth=false, keeps the rest", () => {
  const doc = asRecord(parse(stripModelProvider(CONFIG)));
  // model_provider gone; unrelated keys/sections preserved.
  expect(doc.model_provider).toBeUndefined();
  expect(doc.web_search).toBe("live");
  expect(asRecord(doc.my_custom).keep).toBe("me");
  // requires_openai_auth flipped to false on our managed table (was true).
  const providers = asRecord(doc.model_providers);
  expect(asRecord(providers["copilot-env"]).requires_openai_auth).toBe(false);
  // The provider tables themselves survive.
  expect(asRecord(providers["copilot-env"]).base_url).toBe("http://localhost:4141/v1");
  expect(asRecord(providers.other).base_url).toBe("https://api.githubcopilot.com");
});

test("restoreModelProvider puts the provider back and round-trips through strip", () => {
  const stripped = stripModelProvider(CONFIG);
  expect(readModelProvider(stripped)).toBe(null);
  const restored = restoreModelProvider(stripped, "copilot-env");
  expect(readModelProvider(restored)).toBe("copilot-env");
  // requires_openai_auth stays false after restore.
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

  // An absent key round-trips as absent (restore with null adds nothing).
  const neverHad = restoreModelProvider(stripModelProvider(CONFIG), "copilot-env", null);
  expect(readModelCatalogJson(neverHad)).toBe(null);
});

// --- the three-state app scans and their gates --------------------------------

test("closeGateFromScan: proven absence proceeds silently; present and unproven take the gate", () => {
  // Proven-absent (the scan ran and found nothing): the silent proceed, unchanged.
  expect(closeGateFromScan("absent")).toEqual({ close: false });

  // Proven-present: the interactive close gate, no warn, unchanged.
  expect(closeGateFromScan("present")).toEqual({
    close: true,
    warn: null,
    prompt: "The Codex app is open. Close it now?",
  });

  // A FAILED look is unproven: the honest warn plus the SAME interactive gate --
  // never the silent proceed that would swap config under a possibly-open app.
  // The prompt claims "possibly open", never "is open".
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

test("installGateFromScan: present proceeds; proven absence aborts; unproven asks", () => {
  expect(installGateFromScan("present")).toEqual({ kind: "proceed" });
  expect(installGateFromScan("absent")).toEqual({
    kind: "abort",
    warn: "The Codex app does not appear to be installed.",
    info: "Install the Codex app, then re-run `agent codex --mobile`.",
  });
  // A FAILED look is NOT "not installed": it says the scan could not check and asks
  // the user, never the false abort.
  expect(installGateFromScan("unproven")).toEqual({
    kind: "confirm",
    warn: "The install scan failed, so it could not check whether the Codex app is installed.",
    prompt: "Continue with pairing anyway?",
  });
});

test("postPairingCloseFromScan: only PROVEN-present quits; unproven warns, never quits", () => {
  expect(postPairingCloseFromScan("present")).toEqual({ quit: true, warn: null });
  expect(postPairingCloseFromScan("absent")).toEqual({ quit: false, warn: null });
  // No new signal authorization: the failed look does not escalate into quit(), and
  // it keeps the honest warn -- restore proceeds under an app the scan could not
  // prove closed.
  expect(postPairingCloseFromScan("unproven")).toEqual({
    quit: false,
    warn: "The process scan failed, so it could not prove the Codex app is closed.",
  });
});

test("quit() ends early only on a PROVEN absence; anything else rides to the deadline force-quit", async () => {
  const quitCalls = async (result: { exitCode: number; stdout: string; launchFailed?: true }) => {
    const calls: { file: string; args: string[] }[] = [];
    const app = new CodexAppController(
      (file, args) => {
        calls.push({ file, args });
        return Promise.resolve(result);
      },
      "darwin",
      { timeoutMs: 60, pollMs: 5 },
    );
    await app.quit();
    return calls;
  };

  // Proven absence: the first poll ends the wait -- the polite ask-quit went out,
  // and the force-quit never fires.
  const absent = await quitCalls({ exitCode: 1, stdout: "" });
  expect(absent[0]?.file).toBe("osascript");
  expect(absent.some((c) => c.file === "pkill")).toBe(false);

  // An UNPROVEN look cannot satisfy "ensure the app is closed": no early return --
  // the poll keeps looking and the pre-existing deadline force-quit fires.
  const unproven = await quitCalls({ exitCode: 1, stdout: "", launchFailed: true });
  expect(unproven.filter((c) => c.file === "pgrep").length).toBeGreaterThanOrEqual(1);
  expect(unproven.at(-1)?.file).toBe("pkill");

  // Proven-present overstay: unchanged -- polls to the deadline, then force-quits.
  const present = await quitCalls({ exitCode: 0, stdout: "" });
  expect(present.at(-1)?.file).toBe("pkill");
});

/** A controller whose process executor replays `result` and records the calls. */
function scannedController(
  platform: "darwin" | "win32",
  result: { exitCode: number; stdout: string; launchFailed?: true },
  calls: { file: string; args: string[] }[] = [],
): CodexAppController {
  return new CodexAppController((file, args) => {
    calls.push({ file, args });
    return Promise.resolve(result);
  }, platform);
}

test("runningState/installedState three-state their scans per platform", async () => {
  // POSIX: the tools' own exit vocabulary, read through the launch-failure mark.
  const posix = (result: { exitCode: number; stdout: string; launchFailed?: true }) =>
    scannedController("darwin", result);
  expect(await posix({ exitCode: 0, stdout: "" }).runningState()).toBe("present");
  expect(await posix({ exitCode: 1, stdout: "" }).runningState()).toBe("absent");
  expect(await posix({ exitCode: 1, stdout: "", launchFailed: true }).runningState())
    .toBe("unproven"); // pgrep never ran: the coerced exit 1 must not read as absence
  expect(await posix({ exitCode: 3, stdout: "" }).runningState()).toBe("unproven");
  expect(await posix({ exitCode: 1, stdout: "", launchFailed: true }).installedState())
    .toBe("unproven"); // same discipline on the install look (`open -Ra`)

  // Windows: the scripts mint verdict words, and those are the ONLY confident
  // readings -- a script that errored (exit 1, verdict-less) or a PowerShell that
  // never launched can present none.
  const win = (result: { exitCode: number; stdout: string; launchFailed?: true }) =>
    scannedController("win32", result);
  for (const method of ["runningState", "installedState"] as const) {
    expect(await win({ exitCode: 0, stdout: "present\r\n" })[method]()).toBe("present");
    expect(await win({ exitCode: 0, stdout: "absent\r\n" })[method]()).toBe("absent");
    expect(await win({ exitCode: 1, stdout: "" })[method]()).toBe("unproven");
    expect(await win({ exitCode: 1, stdout: "", launchFailed: true })[method]())
      .toBe("unproven");
    expect(await win({ exitCode: 0, stdout: "garbage" })[method]()).toBe("unproven");
  }

  // The scans are the documented primitives, and the Windows proven absence is the
  // SPECIFIC no-match error id -- not any script failure flattened into one.
  const calls: { file: string; args: string[] }[] = [];
  await scannedController("darwin", { exitCode: 1, stdout: "" }, calls).runningState();
  await scannedController("darwin", { exitCode: 1, stdout: "" }, calls).installedState();
  expect(calls[0]?.file).toBe("pgrep");
  expect(calls[0]?.args).toEqual(["-x", "Codex"]);
  expect(calls[1]?.file).toBe("open");
  expect(calls[1]?.args).toEqual(["-Ra", "Codex"]);

  const winCalls: { file: string; args: string[] }[] = [];
  await scannedController("win32", { exitCode: 0, stdout: "present" }, winCalls).runningState();
  await scannedController("win32", { exitCode: 0, stdout: "present" }, winCalls).installedState();
  expect(winCalls[0]?.file).toBe("powershell");
  expect(winCalls[0]?.args.at(-1)).toContain("NoProcessFoundForGivenName");
  expect(winCalls[1]?.args.at(-1)).toContain("Get-StartApps");
  // The installed look's Get-Process fallback carries the SAME discriminant: a real
  // Get-Process error is never suppressed into a proven "absent".
  expect(winCalls[1]?.args.at(-1)).toContain("NoProcessFoundForGivenName");
});

test("the real POSIX scans three-state pgrep/open: 0 present, 1 proven absent, else unproven", async () => {
  if (process.platform === "win32") return; // pgrep/open are the POSIX primitives
  const dir = mkdtempSync(join(tmpdir(), "codex-mobile-scan-"));
  const originalPath = process.env.PATH;
  try {
    // PATH pinned to a dir holding ONLY the fake tools, so the real ones can never
    // answer for a fake and a removed fake is a REAL spawn failure.
    const fake = (tool: string, exit: number) =>
      writeFileSync(join(dir, tool), `#!/bin/sh\nexit ${exit}\n`, { mode: 0o755 });
    process.env.PATH = dir;
    for (const [exit, want] of [[0, "present"], [1, "absent"], [3, "unproven"]] as const) {
      fake("pgrep", exit);
      expect(await new CodexAppController().runningState()).toBe(want);
      fake("open", exit);
      expect(await new CodexAppController().installedState()).toBe(want);
    }
    // The spawn-failure arm: runCaptured coerces ENOENT to exit 1 WITH the mark --
    // never pgrep's own proven-absent exit 1.
    rmSync(join(dir, "pgrep"));
    expect(await new CodexAppController().runningState()).toBe("unproven");
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real Windows running scan mints a verdict word on a healthy host", async () => {
  if (process.platform !== "win32") return; // drives real Windows PowerShell
  // The completeness control: on a healthy host the script must RUN and mint a
  // verdict word -- a PowerShell-5.1-incompatible script or a wrong no-match
  // discriminant would read "unproven" here and go red.
  expect(["present", "absent"]).toContain(await new CodexAppController().runningState());
});
