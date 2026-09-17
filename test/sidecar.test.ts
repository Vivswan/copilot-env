import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
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

function plantSidecar(rootHome: string, version: string, platform = "linux"): string {
  const bin = sidecarBinPath(rootHome, version, platform);
  mkdirSync(join(rootHome, "deno", version), { recursive: true });
  writeFileSync(bin, "#!fake");
  return bin;
}

/** A call's result as data, so a table row can expect a value or an error by its text. */
type Outcome<T> = { value: T } | { error: string };

function outcomeOf<T>(fn: () => T): Outcome<T> {
  try {
    return { value: fn() };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** The row's expected error is a fragment of the thrown message; a value is exact. */
function expectOutcome<T>(label: string, actual: Outcome<T>, expected: Outcome<T>): void {
  expect({ label, ...actual }).toEqual(
    "error" in expected
      ? { label, error: expect.stringContaining(expected.error) }
      : { label, value: expected.value },
  );
}

describe("parseAbsolutePath", () => {
  // A relative or empty path is refused at the boundary: no caller may resolve it against a cwd it
  // does not control.
  test("accepts an absolute path trimmed; rejects relative and empty ones", () => {
    const rows: { input: string; expected: Outcome<string> }[] = [
      { input: " /usr/bin/deno ", expected: { value: "/usr/bin/deno" } },
      { input: "bin/deno", expected: { error: "absolute path" } },
      { input: "  ", expected: { error: "absolute path" } },
    ];
    for (const row of rows) {
      expectOutcome(row.input, outcomeOf(() => parseAbsolutePath(row.input)), row.expected);
    }
  });
});

describe("resolveDenoBin", () => {
  // The precedence ladder: override, then the running Deno, then a PATH deno, then the newest
  // provisioned sidecar, else a hard error. A PATH deno beats a provisioned copy even when one
  // exists (the user's toolchain always wins), and bare call sites default rootHome to the
  // resolved root home, where ensureSidecar provisions (the compiled-install regression).
  test("the precedence ladder: override, runtime, PATH, newest provisioned, else a hard error", () => {
    const home = join(dir, "home");
    const provisioned = plantSidecar(home, PIN);
    const versions = join(dir, "versions");
    plantSidecar(versions, "2.9.5");
    const newest = plantSidecar(versions, "2.10.1");
    plantSidecar(versions, "2.10.0");
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const live = runtimeExecPath() ?? "(not under deno)";

    const rows: {
      label: string;
      override?: string;
      rootHome: string | undefined;
      opts?: Omit<Parameters<typeof detectSidecar>[1], "env">;
      expected: Outcome<string>;
    }[] = [
      {
        label: "the COPILOT_ENV_SIDECAR_DENO env override wins over everything",
        override: "/opt/deno/bin/deno",
        rootHome: undefined,
        expected: { value: "/opt/deno/bin/deno" },
      },
      {
        label: "a relative override is rejected at the boundary, never resolved against a cwd",
        override: "deno",
        rootHome: undefined,
        expected: { error: "absolute path" },
      },
      {
        // The suite runs under `deno test`, so the runtime fast path is live.
        label: "without an override, the running Deno's own binary is used",
        rootHome: undefined,
        expected: { value: live },
      },
      {
        label: "a checkout's own deno outranks a PATH deno: subprocesses match the parent",
        rootHome: home,
        opts: { "runtimeExecPath": "/checkout/deno", "findDeno": () => "/opt/homebrew/bin/deno" },
        expected: { value: "/checkout/deno" },
      },
      {
        label: "a compiled standalone uses the deno already on PATH, over a provisioned copy",
        rootHome: home,
        opts: {
          "runtimeExecPath": null,
          "platform": "linux",
          "findDeno": () => "/opt/homebrew/bin/deno",
        },
        expected: { value: "/opt/homebrew/bin/deno" },
      },
      {
        label: "no PATH deno: the NEWEST provisioned sidecar under the root home answers",
        rootHome: versions,
        opts: { "runtimeExecPath": null, "platform": "linux", "findDeno": () => null },
        expected: { value: newest },
      },
      {
        label: "rootHome DEFAULTS to the resolved root home, so bare call sites find the sidecar",
        rootHome: undefined,
        opts: { "runtimeExecPath": null, "platform": "linux", "findDeno": () => null },
        expected: { value: provisioned },
      },
      {
        label: "a compiled standalone with no deno anywhere is a hard, actionable error",
        rootHome: empty,
        opts: { "runtimeExecPath": null, "platform": "linux", "findDeno": () => null },
        expected: { error: "no usable deno binary" },
      },
    ];
    // The default-rootHome row must look under the home this test provisioned.
    process.env.COPILOT_API_HOME = home;
    delete process.env.COPILOT_ENV_ROOT_HOME;
    for (const row of rows) {
      if (row.override === undefined) delete process.env[SIDECAR_DENO_ENV];
      else process.env[SIDECAR_DENO_ENV] = row.override;
      const outcome = outcomeOf(() =>
        row.opts === undefined && row.rootHome === undefined
          ? resolveDenoBin()
          : resolveDenoBin({}, row.rootHome, row.opts)
      );
      expectOutcome(row.label, outcome, row.expected);
    }
  });
});

describe("detectSidecar", () => {
  // The same ladder as a whole state: each kind carries exactly its own fields. A provisioned
  // binary lives at `<rootHome>/deno/<x.y.z>/deno`, `deno.exe` on win32 (the on-disk layout
  // ensureSidecar writes and resolveDenoBin reads back).
  test("each ladder rung reports its own kind and fields; a PATH deno outranks a provisioned copy", () => {
    const provisionedHome = join(dir, "provisioned");
    plantSidecar(provisionedHome, PIN, "darwin");
    const windowsHome = join(dir, "windows");
    plantSidecar(windowsHome, PIN, "win32");
    const empty = join(dir, "empty");
    mkdirSync(empty);
    const neverProbed = (): never => {
      throw new Error("PATH must not be probed under an override");
    };

    const rows: {
      label: string;
      rootHome: string;
      opts: Parameters<typeof detectSidecar>[1];
      state: ReturnType<typeof detectSidecar>;
    }[] = [
      {
        label: "env override reports its own kind and never probes PATH",
        rootHome: empty,
        opts: { "env": { [SIDECAR_DENO_ENV]: "/opt/deno/deno" }, "findDeno": neverProbed },
        state: { "kind": "override", "denoBin": parseAbsolutePath("/opt/deno/deno") },
      },
      {
        label: "a live Deno runtime reports dev with its own binary",
        rootHome: empty,
        opts: { "env": {}, "runtimeExecPath": "/checkout/deno" },
        state: { "kind": "dev", "denoBin": parseAbsolutePath("/checkout/deno") },
      },
      {
        label: "a PATH deno reports path, ahead of any provisioned copy",
        rootHome: provisionedHome,
        opts: {
          "env": {},
          "runtimeExecPath": null,
          "platform": "darwin",
          "findDeno": () => "/usr/local/bin/deno",
        },
        state: { "kind": "path", "denoBin": parseAbsolutePath("/usr/local/bin/deno") },
      },
      {
        label: "a provisioned binary on disk is found when nothing else resolves",
        rootHome: provisionedHome,
        opts: { "env": {}, "runtimeExecPath": null, "platform": "darwin", "findDeno": () => null },
        state: {
          "kind": "provisioned",
          "denoBin": parseAbsolutePath(join(provisionedHome, "deno", PIN, "deno")),
          "version": PIN,
        },
      },
      {
        label: "a provisioned binary on win32 carries the .exe suffix",
        rootHome: windowsHome,
        opts: { "env": {}, "runtimeExecPath": null, "platform": "win32", "findDeno": () => null },
        state: {
          "kind": "provisioned",
          "denoBin": parseAbsolutePath(join(windowsHome, "deno", PIN, "deno.exe")),
          "version": PIN,
        },
      },
      {
        label: "nothing available is absent",
        rootHome: empty,
        opts: { "env": {}, "runtimeExecPath": null, "findDeno": () => null },
        state: { "kind": "absent" },
      },
    ];
    for (const row of rows) {
      expect({ label: row.label, state: detectSidecar(row.rootHome, row.opts) }).toEqual({
        label: row.label,
        state: row.state,
      });
    }
  });
});

describe("provisionedSidecar", () => {
  test("the newest parseable, binary-carrying version wins the scan; no deno dir is null", () => {
    expect(provisionedSidecar(dir, "darwin")).toBeNull(); // no deno dir at all: null, not an error
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
});

describe(".dvmrc reference version", () => {
  // One trimmed x.y.z line and nothing else; the file read names a missing file actionably.
  test("parses one trimmed x.y.z line, rejects anything else; readDvmrcPin reads the project-root file", () => {
    const rows: { text: string; expected: Outcome<string> }[] = [
      { text: "2.9.5\n", expected: { value: "2.9.5" } },
      { text: "  2.9.5  ", expected: { value: "2.9.5" } },
      { text: "v2.9.5", expected: { error: "x.y.z" } },
      { text: "2.9", expected: { error: "x.y.z" } },
      { text: "2.9.5\n2.9.6", expected: { error: "x.y.z" } },
      { text: "", expected: { error: "x.y.z" } },
    ];
    for (const row of rows) {
      expectOutcome(row.text, outcomeOf(() => parseDvmrcPin(row.text)), row.expected);
    }
    writeFileSync(join(dir, DVMRC_FILENAME), "2.9.5\n");
    expect(readDvmrcPin(dir)).toBe("2.9.5");
    expect(() => readDvmrcPin(join(dir, "nowhere"))).toThrow("cannot read");
  });
});

describe("denoReleaseTarget", () => {
  test("maps every supported platform-arch pair; an unsupported pair throws, listing them", () => {
    expect(denoReleaseTarget("darwin", "arm64")).toBe("aarch64-apple-darwin");
    expect(denoReleaseTarget("darwin", "x64")).toBe("x86_64-apple-darwin");
    expect(denoReleaseTarget("linux", "arm64")).toBe("aarch64-unknown-linux-gnu");
    expect(denoReleaseTarget("linux", "x64")).toBe("x86_64-unknown-linux-gnu");
    expect(denoReleaseTarget("win32", "x64")).toBe("x86_64-pc-windows-msvc");
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

  test("fetchLatestDenoVersion parses the one-line pointer and strips the v; a dead endpoint or garbage names the manual escapes", async () => {
    const { fetchLike } = fetchServing({ [DENO_LATEST_URL]: "v2.11.3\n" });
    expect(await fetchLatestDenoVersion(fetchLike)).toBe("2.11.3");
    const { fetchLike: dead } = fetchServing({ [DENO_LATEST_URL]: { "status": 500 } });
    await expect(fetchLatestDenoVersion(dead)).rejects.toThrow(SIDECAR_DENO_ENV);
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
    if (process.platform !== "win32") {
      expect(statSync(bin).mode & 0o100).not.toBe(0);
    }
    const leftovers = readdirSync(join(dir, "deno", PIN)).filter((n) => n.includes(".zip"));
    expect(leftovers).toEqual([]);
  });

  // Every failure after the download is loud and names its cause: the extractor's stderr, a
  // zip with no binary in it, or the HTTP status of a failed fetch.
  test("a failing extractor, a binary-less extraction, and an HTTP error each fail naming the cause", async () => {
    const rows: {
      label: string;
      body: string | null;
      status: number;
      runner?: (command: string, args: readonly string[]) => { status: number; stderr: string };
      error: string;
    }[] = [
      {
        label: "a failing extractor is surfaced with its stderr",
        body: "hello",
        status: 200,
        runner: () => ({ "status": 9, "stderr": "bad zip" }),
        error: "bad zip",
      },
      {
        label: "an extractor that does not produce the binary fails loud",
        body: "hello",
        status: 200,
        runner: () => ({ "status": 0, "stderr": "" }),
        error: "did not produce",
      },
      {
        label: "an HTTP error is surfaced with its status",
        body: null,
        status: 404,
        error: "HTTP 404",
      },
    ];
    for (const row of rows) {
      const { fetchLike } = fakeFetch(row.body, row.status);
      const failure = await downloadSidecar(PIN, dir, HELLO_SHA256, {
        "fetchLike": fetchLike,
        "platform": "darwin",
        "arch": "arm64",
        ...(row.runner === undefined ? {} : { "runner": row.runner }),
      }).then(() => "(resolved)", (err: Error) => err.message);
      expect({ label: row.label, failure }).toEqual({
        label: row.label,
        failure: expect.stringContaining(row.error),
      });
    }
  });
});

describe("ensureSidecar", () => {
  // A fetch from any rung above "absent" would be a live network call on every `agent start`.
  test("the running deno, an env override, or a PATH deno answers with no download", async () => {
    const mustNotFetch = (): Promise<Response> => Promise.reject(new Error("must not fetch"));
    const rows: {
      label: string;
      override?: string;
      opts: Omit<Parameters<typeof ensureSidecar>[1], "fetchLike">;
      bin: string;
    }[] = [
      {
        label: "running under a real deno is a no-op: our own runtime IS the answer",
        opts: {},
        bin: runtimeExecPath() ?? "(not under deno)",
      },
      {
        label: "an env override wins and still never downloads",
        override: "/opt/deno/bin/deno",
        opts: {},
        bin: "/opt/deno/bin/deno",
      },
      {
        label: "a PATH deno answers with no download -- the user's toolchain wins",
        opts: { "runtimeExecPath": null, "findDeno": () => "/opt/homebrew/bin/deno" },
        bin: "/opt/homebrew/bin/deno",
      },
    ];
    for (const row of rows) {
      if (row.override === undefined) delete process.env[SIDECAR_DENO_ENV];
      else process.env[SIDECAR_DENO_ENV] = row.override;
      const bin = await ensureSidecar(dir, { ...row.opts, fetchLike: mustNotFetch });
      expect({ label: row.label, bin }).toEqual({ label: row.label, bin: row.bin });
    }
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
