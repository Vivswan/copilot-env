import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareDenoVersions,
  DENO_LATEST_URL,
  DENO_RELEASE_TARGETS,
  denoReleaseTarget,
  denoReleaseUrl,
  detectSidecar,
  downloadSidecar,
  DVMRC_FILENAME,
  ensureSidecar,
  fetchLatestDenoVersion,
  fetchReleaseSha256,
  parseAbsolutePath,
  parseDvmrcPin,
  provisionedSidecar,
  readDvmrcPin,
  resolveDenoBin,
  SIDECAR_DENO_ENV,
  sidecarBinPath,
  sidecarStatus,
  unzipCommand,
} from "../src/copilot_api/sidecar.ts";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  removeDir,
  tempDir,
  test,
} from "./helpers/testing.ts";
import { envSnapshot } from "./helpers.ts";

const PIN = "2.9.5";
// sha256("hello"), the classic test vector -- the fake download below serves "hello".
const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

let dir = "";
const restoreEnv = envSnapshot([SIDECAR_DENO_ENV]);

beforeEach(() => {
  dir = tempDir("copilot-sidecar-");
  delete process.env[SIDECAR_DENO_ENV];
});

afterEach(() => {
  restoreEnv();
  dir = removeDir(dir);
});

function runtimeExecPath(): string | undefined {
  return (globalThis as { Deno?: { execPath(): string } }).Deno?.execPath();
}

/** Plant a fake provisioned sidecar for `version` under `rootHome`. */
function plantSidecar(rootHome: string, version: string, platform = "linux"): string {
  const bin = sidecarBinPath(rootHome, version, platform);
  mkdirSync(join(rootHome, "deno", version), { recursive: true });
  writeFileSync(bin, "#!fake");
  return bin;
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
  test("the COPILOT_ENV_SIDECAR_DENO env override wins over everything", () => {
    process.env[SIDECAR_DENO_ENV] = "/opt/deno/bin/deno";
    expect(resolveDenoBin()).toBe("/opt/deno/bin/deno");
  });

  test("a relative override is rejected at the boundary", () => {
    process.env[SIDECAR_DENO_ENV] = "deno";
    expect(() => resolveDenoBin()).toThrow("absolute path");
  });

  test("without an override, the running Deno's own binary is used", () => {
    // The suite runs under `deno test`, so the runtime fast path is live; the
    // standalone branches are pinned via the runtimeExecPath seam below.
    expect(resolveDenoBin()).toBe(runtimeExecPath() ?? "(not under deno)");
  });

  test("a checkout's own deno outranks a PATH deno: subprocesses match the parent", () => {
    expect(
      resolveDenoBin({}, dir, {
        "runtimeExecPath": "/checkout/deno",
        "findDeno": () => "/opt/homebrew/bin/deno",
      }),
    ).toBe("/checkout/deno");
  });

  test("a compiled standalone uses the deno already on PATH", () => {
    // Even when a provisioned copy exists: the user's toolchain always wins.
    plantSidecar(dir, PIN);
    expect(
      resolveDenoBin({}, dir, {
        "runtimeExecPath": null,
        "platform": "linux",
        "findDeno": () => "/opt/homebrew/bin/deno",
      }),
    ).toBe("/opt/homebrew/bin/deno");
  });

  test("no PATH deno: the NEWEST provisioned sidecar under the root home answers", () => {
    plantSidecar(dir, "2.9.5");
    const newest = plantSidecar(dir, "2.10.1");
    plantSidecar(dir, "2.10.0");
    expect(
      resolveDenoBin({}, dir, {
        "runtimeExecPath": null,
        "platform": "linux",
        "findDeno": () => null,
      }),
    ).toBe(newest);
  });

  test("rootHome DEFAULTS to the resolved root home, so bare call sites find the sidecar", () => {
    // The compiled-install regression: every production call site is bare, so the
    // default must look where ensureSidecar provisions -- the root home, not nowhere.
    process.env.COPILOT_API_HOME = dir;
    delete process.env.COPILOT_ENV_ROOT_HOME;
    const bin = plantSidecar(dir, PIN);
    expect(
      resolveDenoBin({}, undefined, {
        "runtimeExecPath": null,
        "platform": "linux",
        "findDeno": () => null,
      }),
    ).toBe(bin);
  });

  test("a compiled standalone with no deno anywhere is a hard, actionable error", () => {
    expect(() =>
      resolveDenoBin({}, dir, {
        "runtimeExecPath": null,
        "platform": "linux",
        "findDeno": () => null,
      })
    ).toThrow("no usable deno binary");
  });
});

describe("detectSidecar", () => {
  test("env override reports its own kind and never probes PATH", () => {
    const state = detectSidecar(dir, {
      "env": { [SIDECAR_DENO_ENV]: "/opt/deno/deno" },
      "findDeno": () => {
        throw new Error("PATH must not be probed under an override");
      },
    });
    expect(state).toEqual({ "kind": "override", "denoBin": "/opt/deno/deno" });
  });

  test("a live Deno runtime reports dev with its own binary", () => {
    const state = detectSidecar(dir, { "env": {}, "runtimeExecPath": "/checkout/deno" });
    expect(state).toEqual({ "kind": "dev", "denoBin": "/checkout/deno" });
  });

  test("a PATH deno reports path, ahead of any provisioned copy", () => {
    plantSidecar(dir, PIN, "darwin");
    const state = detectSidecar(dir, {
      "env": {},
      "runtimeExecPath": null,
      "platform": "darwin",
      "findDeno": () => "/usr/local/bin/deno",
    });
    expect(state).toEqual({ "kind": "path", "denoBin": "/usr/local/bin/deno" });
  });

  test("a provisioned binary on disk is found when nothing else resolves", () => {
    const bin = plantSidecar(dir, PIN, "darwin");
    const state = detectSidecar(dir, {
      "env": {},
      "runtimeExecPath": null,
      "platform": "darwin",
      "findDeno": () => null,
    });
    expect(state).toEqual({ "kind": "provisioned", "denoBin": bin, "version": PIN });
  });

  test("nothing available is absent", () => {
    const state = detectSidecar(dir, {
      "env": {},
      "runtimeExecPath": null,
      "findDeno": () => null,
    });
    expect(state).toEqual({ "kind": "absent" });
  });
});

describe("compareDenoVersions / provisionedSidecar", () => {
  test("numeric x.y.z order; unparseable versions never compare", () => {
    expect(compareDenoVersions("2.9.5", "2.10.0")).toBeLessThan(0);
    expect(compareDenoVersions("2.10.0", "2.9.5")).toBeGreaterThan(0);
    expect(compareDenoVersions("2.9.5", "2.9.5")).toBe(0);
    expect(compareDenoVersions("v2.9.5", "2.9.5")).toBeNull();
    expect(compareDenoVersions("2.9.5", "canary")).toBeNull();
  });

  test("the newest parseable, binary-carrying version wins the scan", () => {
    plantSidecar(dir, "2.9.5", "darwin");
    const newest = plantSidecar(dir, "2.10.2", "darwin");
    mkdirSync(join(dir, "deno", "2.99.0"), { recursive: true }); // dir with no binary
    mkdirSync(join(dir, "deno", "junk"), { recursive: true }); // non-version dir
    expect(provisionedSidecar(dir, "darwin")).toEqual({
      "kind": "provisioned",
      "denoBin": newest,
      "version": "2.10.2",
    });
  });

  test("no deno dir at all is null, not an error", () => {
    expect(provisionedSidecar(dir, "darwin")).toBeNull();
  });
});

describe("sidecarBinPath", () => {
  test("appends .exe only on win32", () => {
    expect(sidecarBinPath(dir, PIN, "darwin")).toBe(join(dir, "deno", PIN, "deno"));
    expect(sidecarBinPath(dir, PIN, "win32")).toBe(join(dir, "deno", PIN, "deno.exe"));
  });
});

describe(".dvmrc reference version", () => {
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
  test("points at the versioned GitHub release asset", () => {
    expect(denoReleaseUrl(PIN, "aarch64-apple-darwin")).toBe(
      `https://github.com/denoland/deno/releases/download/v${PIN}/deno-aarch64-apple-darwin.zip`,
    );
  });
});

describe("latest-release resolution", () => {
  function fetchServing(routes: Record<string, string | { status: number }>): {
    calls: string[];
    fetchLike: typeof fetch;
  } {
    const calls: string[] = [];
    const fetchLike: typeof fetch = ((url: string | URL | Request) => {
      const key = String(url);
      calls.push(key);
      const route = routes[key];
      if (route === undefined) return Promise.resolve(new Response(null, { "status": 404 }));
      if (typeof route === "string") return Promise.resolve(new Response(route));
      return Promise.resolve(new Response(null, { "status": route.status }));
    }) as typeof fetch;
    return { calls, fetchLike };
  }

  test("fetchLatestDenoVersion parses the one-line pointer and strips the v", async () => {
    const { fetchLike } = fetchServing({ [DENO_LATEST_URL]: "v2.11.3\n" });
    expect(await fetchLatestDenoVersion(fetchLike)).toBe("2.11.3");
  });

  test("a dead endpoint (or garbage) is a clear error naming the manual escapes", async () => {
    const { fetchLike } = fetchServing({ [DENO_LATEST_URL]: { "status": 500 } });
    await expect(fetchLatestDenoVersion(fetchLike)).rejects.toThrow(SIDECAR_DENO_ENV);
    // A malformed 200 body carries the SAME recovery guidance as a dead endpoint
    // (a deno-less machine has nothing else to act on), plus the parse detail.
    const { fetchLike: garbage } = fetchServing({ [DENO_LATEST_URL]: "<html>oops</html>" });
    await expect(fetchLatestDenoVersion(garbage)).rejects.toThrow(SIDECAR_DENO_ENV);
    await expect(fetchLatestDenoVersion(garbage)).rejects.toThrow("x.y.z");
  });

  test("fetchReleaseSha256 reads both published formats and normalises case", async () => {
    const url = `${denoReleaseUrl("2.11.3", "x86_64-unknown-linux-gnu")}.sha256sum`;
    const posix = fetchServing({ [url]: `${HELLO_SHA256}  deno-x86_64-unknown-linux-gnu.zip\n` });
    expect(await fetchReleaseSha256("2.11.3", "x86_64-unknown-linux-gnu", posix.fetchLike)).toBe(
      HELLO_SHA256,
    );
    const psText = `Algorithm : SHA256\nHash : ${HELLO_SHA256.toUpperCase()}\n`;
    const ps = fetchServing({ [url]: psText });
    expect(await fetchReleaseSha256("2.11.3", "x86_64-unknown-linux-gnu", ps.fetchLike)).toBe(
      HELLO_SHA256,
    );
    const empty = fetchServing({ [url]: "no digest here" });
    await expect(fetchReleaseSha256("2.11.3", "x86_64-unknown-linux-gnu", empty.fetchLike))
      .rejects.toThrow("did not yield a sha256");
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
        // The zip must be fully on disk when the extractor runs, and the extraction
        // target (`-d`) is where the binary appears before it is moved into place.
        expect(existsSync(args[2] ?? "")).toBe(true);
        writeFileSync(join(args[4] ?? "", "deno"), "#!fake deno");
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

  test("a PATH deno answers with no download -- the user's toolchain wins", async () => {
    const bin = await ensureSidecar(dir, {
      "runtimeExecPath": null,
      "findDeno": () => "/opt/homebrew/bin/deno",
      fetchLike: () => Promise.reject(new Error("must not fetch")),
    });
    expect(bin).toBe("/opt/homebrew/bin/deno");
  });

  test("nothing anywhere: resolves the LATEST release, verifies its published sha256, provisions", async () => {
    const latest = "2.11.3";
    const target = "x86_64-unknown-linux-gnu";
    const calls: string[] = [];
    const fetchLike: typeof fetch = ((url: string | URL | Request) => {
      const key = String(url);
      calls.push(key);
      if (key === DENO_LATEST_URL) return Promise.resolve(new Response(`v${latest}\n`));
      if (key === `${denoReleaseUrl(latest, target)}.sha256sum`) {
        return Promise.resolve(new Response(`${HELLO_SHA256}  deno-${target}.zip\n`));
      }
      if (key === denoReleaseUrl(latest, target)) {
        return Promise.resolve(new Response("hello"));
      }
      return Promise.resolve(new Response(null, { "status": 404 }));
    }) as typeof fetch;
    const bin = await ensureSidecar(dir, {
      "runtimeExecPath": null,
      "findDeno": () => null,
      "platform": "linux",
      "arch": "x64",
      "fetchLike": fetchLike,
      "runner": (_command, args) => {
        writeFileSync(join(args[4] ?? "", "deno"), "#!fake deno");
        return { "status": 0, "stderr": "" };
      },
    });
    expect(bin).toBe(sidecarBinPath(dir, latest, "linux"));
    expect(calls).toEqual([
      DENO_LATEST_URL,
      `${denoReleaseUrl(latest, target)}.sha256sum`,
      denoReleaseUrl(latest, target),
    ]);
  });
});

describe("sidecarStatus", () => {
  test("reports the resolved kind, its version, and the tested reference", () => {
    // The suite runs under deno, so the live status is the dev kind; the seam
    // reads the running binary's own version.
    const status = sidecarStatus(dir, () => "9.9.9");
    expect(status.kind).toBe("dev");
    expect(status.version).toBe("9.9.9");
    expect(status.referenceVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.denoBin).toBe(runtimeExecPath() ?? "(not under deno)");
    expect(status.standalone).toBe(false);
  });
});
