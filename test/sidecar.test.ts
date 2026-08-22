import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DENO_RELEASE_TARGETS,
  denoReleaseTarget,
  denoReleaseUrl,
  detectSidecar,
  downloadSidecar,
  DVMRC_FILENAME,
  ensureSidecar,
  parseAbsolutePath,
  parseDvmrcPin,
  readDvmrcPin,
  resolveDenoBin,
  SIDECAR_DENO_ENV,
  sidecarBinPath,
  unzipCommand,
} from "../src/copilot_api/sidecar.ts";
import { afterEach, beforeEach, describe, expect, test } from "./helpers/testing.ts";
import { sidecarSha256 } from "../src/copilot_api/sidecar_pins.ts";
import { ROOT } from "./helpers/run.ts";
import { envSnapshot, removeDir, tmpDir } from "./helpers.ts";

const PIN = "2.9.5";
// sha256("hello"), the classic test vector -- the fake download below serves "hello".
const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

let dir = "";
const restoreEnv = envSnapshot([SIDECAR_DENO_ENV]);

beforeEach(() => {
  dir = tmpDir("copilot-sidecar-");
  delete process.env[SIDECAR_DENO_ENV];
});

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function runtimeExecPath(): string | undefined {
  return (globalThis as { Deno?: { execPath(): string } }).Deno?.execPath();
}

describe("parseAbsolutePath", () => {
  test("accepts an absolute path, trimmed", () => {
    expect(parseAbsolutePath(" /usr/bin/deno ")).toBe("/usr/bin/deno");
  });

  test("rejects relative and empty paths", () => {
    expect(() => parseAbsolutePath("bin/deno")).toThrow("absolute path");
    expect(() => parseAbsolutePath("  ")).toThrow("absolute path");
  });
});

describe("resolveDenoBin", () => {
  test("the COPILOT_ENV_SIDECAR_DENO env override wins", () => {
    process.env[SIDECAR_DENO_ENV] = "/opt/deno/bin/deno";
    expect(resolveDenoBin()).toBe("/opt/deno/bin/deno");
  });

  test("a relative override is rejected at the boundary", () => {
    process.env[SIDECAR_DENO_ENV] = "deno";
    expect(() => resolveDenoBin()).toThrow("absolute path");
  });

  test("without an override, the running Deno's own binary is used", () => {
    // The suite runs under `deno test`, so the runtime fast path is live. The
    // no-runtime hard-error branch is pinned via detectSidecar's seam below.
    expect(resolveDenoBin()).toBe(runtimeExecPath() ?? "(not under deno)");
  });
});

describe("detectSidecar", () => {
  test("env override reports provisioned at the pin", () => {
    const state = detectSidecar(dir, PIN, { "env": { [SIDECAR_DENO_ENV]: "/opt/deno/deno" } });
    expect(state).toEqual({ "kind": "provisioned", "denoBin": "/opt/deno/deno", "version": PIN });
  });

  test("a live Deno runtime reports dev with its own binary", () => {
    const state = detectSidecar(dir, PIN, { "env": {}, "runtimeExecPath": "/checkout/deno" });
    expect(state).toEqual({ "kind": "dev", "denoBin": "/checkout/deno" });
  });

  test("a provisioned binary on disk is found when not running under Deno", () => {
    const bin = sidecarBinPath(dir, PIN, "darwin");
    mkdirSync(join(dir, "deno", PIN), { recursive: true });
    writeFileSync(bin, "#!fake");
    const state = detectSidecar(dir, PIN, {
      "env": {},
      "runtimeExecPath": null,
      "platform": "darwin",
    });
    expect(state).toEqual({ "kind": "provisioned", "denoBin": bin, "version": PIN });
  });

  test("nothing available is absent, carrying the wanted version", () => {
    const state = detectSidecar(dir, PIN, { "env": {}, "runtimeExecPath": null });
    expect(state).toEqual({ "kind": "absent", "wantedVersion": PIN });
  });
});

describe("sidecarBinPath", () => {
  test("appends .exe only on win32", () => {
    expect(sidecarBinPath(dir, PIN, "darwin")).toBe(join(dir, "deno", PIN, "deno"));
    expect(sidecarBinPath(dir, PIN, "win32")).toBe(join(dir, "deno", PIN, "deno.exe"));
  });
});

describe(".dvmrc pin", () => {
  test("parses one trimmed x.y.z line", () => {
    expect(parseDvmrcPin("2.9.5\n")).toBe("2.9.5");
    expect(parseDvmrcPin("  2.9.5  ")).toBe("2.9.5");
  });

  test("rejects anything but a single exact version", () => {
    expect(() => parseDvmrcPin("v2.9.5")).toThrow("x.y.z");
    expect(() => parseDvmrcPin("2.9")).toThrow("x.y.z");
    expect(() => parseDvmrcPin("2.9.5\n2.9.6")).toThrow("x.y.z");
    expect(() => parseDvmrcPin("")).toThrow("x.y.z");
  });

  test("readDvmrcPin reads the project-root file; a missing file is actionable", () => {
    writeFileSync(join(dir, DVMRC_FILENAME), "2.9.5\n");
    expect(readDvmrcPin(dir)).toBe("2.9.5");
    expect(() => readDvmrcPin(join(dir, "nowhere"))).toThrow("cannot read");
  });
});

describe("denoReleaseTarget", () => {
  test("maps every supported platform-arch pair", () => {
    expect(denoReleaseTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(denoReleaseTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(denoReleaseTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(denoReleaseTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(denoReleaseTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc");
  });

  test("an unsupported pair throws, listing the supported ones", () => {
    expect(() => denoReleaseTarget("linux", "ia32")).toThrow("linux-ia32");
    expect(() => denoReleaseTarget("linux", "ia32")).toThrow(
      Object.keys(DENO_RELEASE_TARGETS).join(", "),
    );
  });
});

describe("denoReleaseUrl", () => {
  test("points at the pinned GitHub release asset", () => {
    expect(denoReleaseUrl(PIN, "aarch64-apple-darwin")).toBe(
      `https://github.com/denoland/deno/releases/download/v${PIN}/deno-aarch64-apple-darwin.zip`,
    );
  });
});

describe("unzipCommand", () => {
  test("uses bsdtar on Windows and unzip elsewhere", () => {
    expect(unzipCommand("/z.zip", "/dest", "win32")).toEqual({
      "command": "tar",
      "args": ["-xf", "/z.zip", "-C", "/dest"],
    });
    expect(unzipCommand("/z.zip", "/dest", "linux")).toEqual({
      "command": "unzip",
      "args": ["-o", "-q", "/z.zip", "-d", "/dest"],
    });
  });
});

describe("downloadSidecar", () => {
  function fakeFetch(body: string | null, status = 200) {
    const calls: string[] = [];
    const fetchLike: typeof fetch = ((url: string | URL | Request) => {
      calls.push(String(url));
      return Promise.resolve(new Response(body, { "status": status }));
    }) as typeof fetch;
    return { calls, fetchLike };
  }

  test("a missing sha256 expectation is a refusal before any network call", async () => {
    const { calls, fetchLike } = fakeFetch("hello");
    await expect(
      downloadSidecar(PIN, dir, undefined, {
        "fetchLike": fetchLike,
        "platform": "darwin",
        "arch": "arm64",
      }),
    ).rejects.toThrow("refusing to download");
    expect(calls).toEqual([]);
  });

  test("a sha256 mismatch refuses and leaves no zip behind", async () => {
    const { fetchLike } = fakeFetch("hello");
    await expect(
      downloadSidecar(PIN, dir, "0".repeat(64), {
        "fetchLike": fetchLike,
        "platform": "darwin",
        "arch": "arm64",
        "runner": () => ({ "status": 0, "stderr": "" }),
      }),
    ).rejects.toThrow("sha256 mismatch");
    const leftovers = readdirSync(join(dir, "deno", PIN)).filter((n) => n.includes(".zip"));
    expect(leftovers).toEqual([]);
  });

  test("verifies, extracts, and returns an executable binary path", async () => {
    const { calls, fetchLike } = fakeFetch("hello");
    const runnerCalls: { command: string; args: string[] }[] = [];
    const bin = await downloadSidecar(PIN, dir, HELLO_SHA256.toUpperCase(), {
      "fetchLike": fetchLike,
      "platform": "darwin",
      "arch": "arm64",
      "runner": (command, args) => {
        runnerCalls.push({ command, "args": [...args] });
        // The zip must be fully on disk when the extractor runs.
        expect(existsSync(args[2] ?? "")).toBe(true);
        writeFileSync(sidecarBinPath(dir, PIN, "darwin"), "#!fake deno");
        return { "status": 0, "stderr": "" };
      },
    });

    expect(calls).toEqual([denoReleaseUrl(PIN, "aarch64-apple-darwin")]);
    expect(bin).toBe(sidecarBinPath(dir, PIN, "darwin"));
    expect(runnerCalls[0]?.command).toBe("unzip");
    // Executable bit set (POSIX hosts only), temp zip cleaned up.
    if (process.platform !== "win32") {
      expect(statSync(bin).mode & 0o100).not.toBe(0);
    }
    const leftovers = readdirSync(join(dir, "deno", PIN)).filter((n) => n.includes(".zip"));
    expect(leftovers).toEqual([]);
  });

  test("a failing extractor is surfaced with its stderr", async () => {
    const { fetchLike } = fakeFetch("hello");
    await expect(
      downloadSidecar(PIN, dir, HELLO_SHA256, {
        "fetchLike": fetchLike,
        "platform": "darwin",
        "arch": "arm64",
        "runner": () => ({ "status": 9, "stderr": "bad zip" }),
      }),
    ).rejects.toThrow("bad zip");
  });

  test("an extractor that does not produce the binary fails loud", async () => {
    const { fetchLike } = fakeFetch("hello");
    await expect(
      downloadSidecar(PIN, dir, HELLO_SHA256, {
        "fetchLike": fetchLike,
        "platform": "darwin",
        "arch": "arm64",
        "runner": () => ({ "status": 0, "stderr": "" }),
      }),
    ).rejects.toThrow("did not produce");
  });

  test("an HTTP error is surfaced with its status", async () => {
    const { fetchLike } = fakeFetch(null, 404);
    await expect(
      downloadSidecar(PIN, dir, HELLO_SHA256, {
        "fetchLike": fetchLike,
        "platform": "darwin",
        "arch": "arm64",
      }),
    ).rejects.toThrow("HTTP 404");
  });
});

// --- the pin table and provisioning ---------------------------------------------

describe("the sha256 pin table", () => {
  test("covers every supported target for the .dvmrc pin", () => {
    // downloadSidecar REFUSES a target with no entry, so a gap here is not a missing
    // optimisation -- it is a platform that cannot provision a sidecar at all.
    const pin = readDvmrcPin(ROOT);
    for (const target of new Set(Object.values(DENO_RELEASE_TARGETS))) {
      const digest = sidecarSha256(pin, target);
      expect(`${target}=${digest ?? "MISSING"}`).toMatch(/=[0-9a-f]{64}$/);
    }
  });

  test("an unknown pin yields no digest, so a .dvmrc bump cannot silently downgrade trust", () => {
    expect(sidecarSha256("0.0.0", "x86_64-unknown-linux-gnu")).toBeUndefined();
  });
});

describe("ensureSidecar", () => {
  test("running under a real deno is a no-op: our own runtime IS the answer", async () => {
    // Never downloads from a checkout -- a fetch here would be a live network call on
    // every `agent start`.
    const bin = await ensureSidecar(dir, {
      fetchLike: () => Promise.reject(new Error("must not fetch")),
    });
    expect(bin).toBe(runtimeExecPath() ?? "(not under deno)");
  });

  test("an env override wins and still never downloads", async () => {
    process.env[SIDECAR_DENO_ENV] = "/opt/deno/bin/deno";
    const bin = await ensureSidecar(dir, {
      fetchLike: () => Promise.reject(new Error("must not fetch")),
    });
    expect(bin).toBe("/opt/deno/bin/deno");
  });
});
