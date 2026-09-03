import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, sep } from "node:path";
import {
  CI_PS_DOCUMENTS_DIR_ENV,
  CI_RC_DIR_ENV,
  LAUNCHERS_MARKER_END,
  MARKER_END,
  posixBlock,
  quotePosix,
  quotePowerShell,
  rcFiles,
  stripBlocks,
  upsertBlock,
  windowsBlock,
  windowsExecutionPolicyCommand,
  windowsProfileTarget,
} from "../src/shell/integration.ts";
import { runCli, runSync } from "./helpers/run.ts";
import { afterEach, beforeEach, expect, test } from "./helpers/testing.ts";

// `agent shell` wires/unwires the rc block. Exercise the POSIX path by
// running the CLI with a throwaway $HOME so we never touch the real rc files.

const MARKER = "# copilot-env shell integration";
const LAUNCHERS_MARKER = "# copilot-env launchers";
// On win32 the command takes the Windows code path (writes the PS $PROFILE, not an
// rc file), so these POSIX-behavior tests only run off Windows.
const skipWin = test.skipIf(process.platform === "win32");
let home = "";

/** upsertBlock's content, for the round-trip assertions that don't inspect leftBehind. */
function up(content: string, marker: Parameters<typeof upsertBlock>[1], block: string): string {
  return upsertBlock(content, marker, block).content;
}

/** A launchers block exactly as pre-`agent launch` releases wired it (the builders are
 *  gone; the strip machinery must still recognize both platform flavors). */
function legacyLaunchersBlock(powershell: boolean): string {
  const body = powershell
    ? "$AgentsLaunchers = 'C:\\x\\shell\\agents.launchers.ps1'\n" +
      "if (Test-Path -LiteralPath $AgentsLaunchers) { . $AgentsLaunchers }"
    : 'AGENTS_LAUNCHERS="/x/shell/agents.launchers.bashrc"\n' +
      '[ -f "$AGENTS_LAUNCHERS" ] && source "$AGENTS_LAUNCHERS"';
  return `\n${LAUNCHERS_MARKER}\n${body}\n${LAUNCHERS_MARKER_END}\n`;
}

/** Occurrences of `marker` as a whole line. The end markers contain the open markers
 *  as substrings, so substring counting would double-count a fenced block. */
function markerLines(content: string, marker: string): number {
  return content.split("\n").filter((l) => l.replace(/\r$/, "") === marker).length;
}

function shellFunctionBody(source: string, name: string): string {
  const match = source.match(new RegExp(`function ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`function ${name} not found`);
  return match[1] as string;
}

/** Run `body` with env var `name` set to `value`, or cleared when null, restoring the
 *  prior value afterwards and returning whatever `body` returned. It mutates this
 *  process because deno's spawnSync MERGES the parent environment: a key merely absent
 *  from a child's `env` option still arrives from the parent, so clearing has to happen
 *  here to take effect there. */
function withEnv<T>(name: string, value: string | null, body: () => T): T {
  const previous = process.env[name];
  if (value === null) delete process.env[name];
  else process.env[name] = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function run(...args: string[]): { code: number | null; out: string } {
  // These tests drive the homedir()/$HOME path on purpose, so the rc-dir seam must not
  // reach the child: it outranks $HOME, and a suite-wide floor may set it.
  const proc = withEnv(CI_RC_DIR_ENV, null, () =>
    runCli(["shell", ...args], {
      env: {
        ...process.env,
        HOME: home,
        SHELL: "/bin/bash",
        CONSOLA_LEVEL: "5",
        COPILOT_API_HOME: home,
      },
    }));
  return { code: proc.exitCode, out: proc.stdout + proc.stderr };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "copilot-si-"));
});
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

skipWin("wires the integration into a freshly created rc file", () => {
  const { code } = run();
  expect(code).toBe(0);
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain(MARKER);
  expect(rc).toContain(MARKER_END); // the block is fenced, so removal is extent-exact
  expect(rc).toContain("agents.bashrc");
});

skipWin("is idempotent -- a second wire is byte-for-byte identical", () => {
  run();
  const first = readFileSync(join(home, ".bashrc"), "utf-8");
  run();
  const second = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(second).toBe(first); // no duplicate block, no reordering
  expect(markerLines(second, MARKER)).toBe(1);
});

skipWin("re-wiring refreshes the block in place without reordering later lines", () => {
  // A stale block followed by a user line that must stay AFTER the integration.
  const stale =
    `${MARKER}\nAGENTS_BASHRC="/old/agents.bashrc"\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"`;
  writeFileSync(join(home, ".bashrc"), `export BEFORE=1\n\n${stale}\n\nexport AFTER=1\n`);
  run();
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain("shell/agents.bashrc"); // migrated in place
  expect(rc).toContain(MARKER_END); // and upgraded to the fenced format
  expect(rc).not.toContain("/old/agents.bashrc");
  // BEFORE still precedes the block; AFTER still follows it.
  expect(rc.indexOf("export BEFORE=1")).toBeLessThan(rc.indexOf(MARKER));
  expect(rc.indexOf(MARKER)).toBeLessThan(rc.indexOf("export AFTER=1"));
});

skipWin("shell wires and removes the integration", () => {
  // Also the strip test: wire (exit 0, block present), then --remove (exit 0,
  // block gone) -- the former separate "--remove strips the block back out"
  // test asserted a strict subset of exactly these steps.
  expect(run().code).toBe(0);
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).toContain(MARKER);
  expect(run("--remove").code).toBe(0);
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).not.toContain(MARKER);
});

skipWin("wires an existing rc without clobbering its contents", () => {
  writeFileSync(join(home, ".bashrc"), "export EXISTING=1\n");
  run();
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain("export EXISTING=1");
  expect(rc).toContain(MARKER);
});

skipWin("--remove strips a CRLF-written block (Windows-style line endings)", () => {
  // Simulate a block written with CRLF (e.g. old PowerShell Add-Content / a CRLF rc).
  const block =
    `\r\n${MARKER}\r\nAGENTS_BASHRC="/x/agents.bashrc"\r\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\r\n`;
  writeFileSync(join(home, ".bashrc"), `export KEEP=1\r\n${block}`);
  const { code } = run("--remove");
  expect(code).toBe(0);
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).not.toContain(MARKER);
  expect(rc).toContain("export KEEP=1");
});

skipWin("--remove still fully removes intact legacy (unfenced) blocks", () => {
  const legacy =
    `${MARKER}\nAGENTS_BASHRC="/x/agents.bashrc"\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"`;
  const launchers =
    `${LAUNCHERS_MARKER}\nAGENTS_LAUNCHERS="/x/agents.launchers.bashrc"\n[ -f "$AGENTS_LAUNCHERS" ] && source "$AGENTS_LAUNCHERS"`;
  writeFileSync(
    join(home, ".bashrc"),
    `export KEEP=1\n\n${legacy}\n\n${launchers}\nexport AFTER=1\n`,
  );
  const { code, out } = run("--remove");
  expect(code).toBe(0);
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).toBe("export KEEP=1\nexport AFTER=1\n");
  expect(out).not.toContain("left in place"); // complete blocks warn about nothing
});

skipWin("--remove on a hand-shortened legacy block spares the user's next line", () => {
  // The user deleted the block's guard line, so the block is 1 line short and the
  // user's own next line sits where the guard used to be. A fixed 3-line cut would
  // eat it; the extent-bounded removal stops at it and says so.
  writeFileSync(
    join(home, ".bashrc"),
    `${MARKER}\nAGENTS_BASHRC="/x/agents.bashrc"\nexport IMPORTANT=do-not-delete\n`,
  );
  const { code, out } = run("--remove");
  expect(code).toBe(0);
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toBe("export IMPORTANT=do-not-delete\n");
  expect(out).toContain("export IMPORTANT=do-not-delete"); // the warning names the spared line
});

skipWin("--remove on a hand-extended legacy block leaves the foreign line, with a warning", () => {
  // A line the user added INSIDE the block: removal stops there instead of cutting past it.
  writeFileSync(
    join(home, ".bashrc"),
    `${MARKER}\nAGENTS_BASHRC="/x/agents.bashrc"\nexport FOREIGN=1\n` +
      `[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\n`,
  );
  const { code, out } = run("--remove");
  expect(code).toBe(0);
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain("export FOREIGN=1");
  expect(rc).not.toContain(MARKER);
  expect(rc).not.toContain("AGENTS_BASHRC=");
  expect(out).toContain("export FOREIGN=1");
});

skipWin(
  "--remove on a fenceless current block (end marker deleted) degrades conservatively",
  () => {
    // The current body shapes are recognized even without the end fence, so removal
    // still stops at the user's line instead of cutting a fixed extent.
    const unfenced = posixBlock(join(homedir(), "shell", "agents.bashrc"))
      .split("\n").filter((l) => l !== MARKER_END).join("\n");
    writeFileSync(join(home, ".bashrc"), `${unfenced}export IMPORTANT=keep\n`);
    const { code, out } = run("--remove");
    expect(code).toBe(0);
    expect(readFileSync(join(home, ".bashrc"), "utf-8")).toBe("export IMPORTANT=keep\n");
    expect(out).not.toContain("left in place"); // the full body was recognized: no warning
  },
);

/** The stored launchers preference (the config key `agent shell --launchers` sets),
 *  read from the per-test store run() points COPILOT_API_HOME at. */
function storedLaunchersKey(): boolean | undefined {
  const file = join(home, ".copilot-env-config.json");
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf-8")) as { launchers?: boolean }).launchers;
}

skipWin("shell --launchers sets the config key and wires NO launchers block", () => {
  // The launchers are `agent env` emissions now: --launchers flips the `launchers`
  // config key; the rc file carries only the integration block.
  expect(run("--launchers").code).toBe(0);
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain(MARKER);
  expect(rc).not.toContain(LAUNCHERS_MARKER);
  expect(markerLines(rc, MARKER)).toBe(1);
  expect(storedLaunchersKey()).toBe(true);
  // A plain re-run leaves the opt-in alone.
  run();
  expect(storedLaunchersKey()).toBe(true);
});

skipWin("shell --launchers --remove disables only the launchers", () => {
  expect(run("--launchers").code).toBe(0);
  expect(run("--launchers", "--remove").code).toBe(0);
  expect(storedLaunchersKey()).toBeUndefined();
  // The integration block stays wired.
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).toContain(MARKER);
});

skipWin("--remove strips the integration, a legacy launchers block, and the opt-in", () => {
  run("--launchers");
  const rcPath = join(home, ".bashrc");
  writeFileSync(rcPath, readFileSync(rcPath, "utf-8") + legacyLaunchersBlock(false));
  run("--remove");
  const rc = readFileSync(rcPath, "utf-8");
  expect(rc).not.toContain(MARKER);
  expect(rc).not.toContain(LAUNCHERS_MARKER);
  expect(storedLaunchersKey()).toBeUndefined();
});

skipWin("re-wiring migrates a stale block to the current shell/ path", () => {
  // Simulate a pre-`shell/`-move block that points at the old root-level agents.bashrc.
  const stale =
    `\n${MARKER}\nAGENTS_BASHRC="/old/agents.bashrc"\n[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\n`;
  writeFileSync(join(home, ".bashrc"), `export KEEP=1\n${stale}`);
  run();
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain("export KEEP=1"); // user content preserved
  expect(rc).toContain("shell/agents.bashrc"); // migrated to the new path
  expect(rc).not.toContain("/old/agents.bashrc"); // stale path gone
  expect(markerLines(rc, MARKER)).toBe(1); // exactly one block, not duplicated
});

skipWin("wiring strips old launchers blocks and carries the opt-in to the config key", () => {
  // A wire over a marker-less rc leaves the opt-in alone (default off) ...
  expect(run().code).toBe(0);
  expect(storedLaunchersKey()).toBeUndefined();
  // ... while the launchers blocks older releases wrote are cleared on the next
  // wire (the file they sourced no longer ships) -- fenced and unfenced legacy
  // flavors alike -- and the opt-in they carried moves to the `launchers` key,
  // so an upgrading user never loses cl/co/cx.
  const unfenced = 'AGENTS_LAUNCHERS="/x/agents.launchers.bashrc"\n' +
    '[ -f "$AGENTS_LAUNCHERS" ] && source "$AGENTS_LAUNCHERS"';
  writeFileSync(
    join(home, ".bashrc"),
    `export KEEP=1\n${
      legacyLaunchersBlock(false)
    }\n${LAUNCHERS_MARKER}\n${unfenced}\nexport AFTER=1\n`,
  );
  expect(run().code).toBe(0);
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain(MARKER);
  expect(rc).not.toContain(LAUNCHERS_MARKER);
  expect(rc).not.toContain("agents.launchers");
  expect(rc).toContain("export KEEP=1");
  expect(rc).toContain("export AFTER=1");
  expect(storedLaunchersKey()).toBe(true); // the migrated opt-in
});

skipWin("posixBlock safely quotes paths with shell metacharacters", () => {
  // A path containing a single quote, $, backtick, and a space must round-trip
  // through `source` as the exact literal -- never expand or break parsing.
  const weird = "/tmp/we'ird $dir/`x`/agents.bashrc";
  const blockFile = join(home, "block.sh");
  writeFileSync(blockFile, posixBlock(weird));
  const proc = runSync("bash", [
    "-c",
    `source "$1"; printf %s "$AGENTS_BASHRC"`,
    "bash",
    blockFile,
  ]);
  expect(proc.stdout).toBe(weird);
});

skipWin("posixBlock anchors a path under the home directory at $HOME", () => {
  // The written block must follow $HOME wherever the rc file travels (dotfile syncs,
  // renamed users). A plain tail gets the readable double-quoted form; a tail with
  // double-quote metacharacters falls back to "$HOME"'<tail>' so only $HOME expands.
  // Both proven by sourcing the block under a DIFFERENT $HOME.
  const plain = posixBlock(join(homedir(), "shell", "agents.bashrc"));
  expect(plain).toContain(`AGENTS_BASHRC="$HOME${sep}shell${sep}agents.bashrc"`);

  const tail = join("we'ird $dir", "shell", "agents.bashrc");
  const blockFile = join(home, "block.sh");
  writeFileSync(blockFile, posixBlock(join(homedir(), tail)));
  const movedHome = join(home, "moved");
  const proc = runSync("bash", [
    "-c",
    `source "$1"; printf %s "$AGENTS_BASHRC"`,
    "bash",
    blockFile,
  ], { env: { ...process.env, HOME: movedHome } });
  expect(proc.stdout).toBe(join(movedHome, tail));
});

test("the PowerShell blocks anchor an under-home path at $HOME, and only then", () => {
  // Parity with posixBlock: a profile synced across machines follows $HOME. A plain
  // tail reads "$HOME\tail"; one with PS metacharacters concatenates a literal; a
  // path outside home (e.g. a dev checkout) stays a single-quoted literal.
  expect(windowsBlock(join(homedir(), "shell", "agents.ps1"))).toContain(
    `$AgentsPs1 = "$HOME${sep}shell${sep}agents.ps1"`,
  );
  const weird = join(homedir(), "we$ird", "agents.ps1");
  expect(windowsBlock(weird)).toContain(
    `$AgentsPs1 = $HOME + '${sep}we$ird${sep}agents.ps1'`,
  );
  const outside = join(sep, "opt", "agents.ps1");
  expect(windowsBlock(outside)).toContain(`$AgentsPs1 = '${outside}'`);
});

// The end markers are new external contracts: existing installs carry only the open
// markers, so those spellings are frozen, and the end fence extends each verbatim.
test("the end markers extend the frozen open markers verbatim", () => {
  expect(MARKER_END).toBe("# copilot-env shell integration end");
  expect(LAUNCHERS_MARKER_END).toBe("# copilot-env launchers end");
});

test("every builder emits a fenced block: open marker first, end marker last", () => {
  const path = join(homedir(), "shell", "x");
  const blocks: Array<[string, string, string]> = [
    [posixBlock(path), MARKER, MARKER_END],
    [windowsBlock(path), MARKER, MARKER_END],
    // Not a builder anymore, but the legacy fixture must keep the retired fence
    // spelling so the strip coverage below can never drift from what was shipped.
    [legacyLaunchersBlock(false), LAUNCHERS_MARKER, LAUNCHERS_MARKER_END],
    [legacyLaunchersBlock(true), LAUNCHERS_MARKER, LAUNCHERS_MARKER_END],
  ];
  for (const [block, marker, end] of blocks) {
    expect(block.startsWith(`\n${marker}\n`)).toBe(true);
    expect(block.endsWith(`\n${end}\n`)).toBe(true);
  }
});

test("a new-format PowerShell block round-trips: write, upsert over it, remove", () => {
  const block = windowsBlock(join(homedir(), "shell", "agents.ps1"));
  const original = "Write-Host before\n";
  const wired = up(original, MARKER, block) + legacyLaunchersBlock(true);
  expect(wired).toContain(MARKER_END);
  expect(wired).toContain(LAUNCHERS_MARKER_END);
  // Upsert over the fenced block is byte-idempotent: the extent comes from the fence.
  expect(up(wired, MARKER, block)).toBe(wired);
  const removed = stripBlocks(wired, [MARKER, LAUNCHERS_MARKER]);
  expect(removed.content).toBe(original);
  expect(removed.leftBehind).toEqual([]);
});

test("re-upserting a CRLF fenced block is byte-idempotent and keeps CRLF", () => {
  // e.g. a $PROFILE some Windows tool rewrote with CRLF: the refresh must not flip
  // the block's endings (that would be a spurious diff on every re-wire).
  const block = windowsBlock(join(homedir(), "shell", "agents.ps1"));
  const crlf = up("Write-Host before\n", MARKER, block).replaceAll("\n", "\r\n");
  expect(up(crlf, MARKER, block)).toBe(crlf);
  const removed = stripBlocks(crlf, [MARKER]);
  expect(removed.content).toBe("Write-Host before\r\n");
  expect(removed.leftBehind).toEqual([]);
  // A CRLF file with no final newline stays unterminated instead of gaining a lone \r.
  const unterminated = crlf.replace(/\r\n$/, "");
  expect(up(unterminated, MARKER, block)).toBe(unterminated);
});

test("a first wire into a CRLF file appends CRLF, never mixed endings", () => {
  // Before this, only the REFRESH path preserved CRLF (off the marker line); a first
  // append into e.g. a Notepad-written $PROFILE left LF lines in a CRLF file.
  const block = windowsBlock(join(homedir(), "shell", "agents.ps1"));
  const wired = up("Write-Host before\r\n", MARKER, block);
  expect(wired).toBe(
    up("Write-Host before\n", MARKER, block).replaceAll("\n", "\r\n"),
  );
  expect(wired).not.toMatch(/[^\r]\n/); // no lone LF anywhere
  // The append seeds a CRLF marker line, so the refresh path keeps it idempotent.
  expect(up(wired, MARKER, block)).toBe(wired);
});

test("an append matches the file's DOMINANT ending, not any stray one", () => {
  const block = windowsBlock(join(homedir(), "shell", "agents.ps1"));
  // One stray CRLF in an LF file must not flip the appended block to CRLF...
  const mostlyLf = "a\nb\nc\r\nd\n";
  expect(up(mostlyLf, MARKER, block)).toBe(mostlyLf + block);
  // ...and one stray LF in a CRLF file must not keep it LF.
  const mostlyCrlf = "a\r\nb\r\nc\nd\r\n";
  expect(up(mostlyCrlf, MARKER, block)).toBe(
    mostlyCrlf + block.replaceAll("\n", "\r\n"),
  );
  // A tie stays LF, like an empty (or new) file: the builders' platform-neutral form.
  expect(up("a\r\nb\n", MARKER, block)).toBe("a\r\nb\n" + block);
  expect(up("", MARKER, block)).toBe(block);
  // A CRLF file with an unterminated last line still appends CRLF.
  expect(up("a\r\nb", MARKER, block)).toBe("a\r\nb" + block.replaceAll("\n", "\r\n"));
});

test("upsert refreshes the first duplicate block and strips the rest", () => {
  // Two markers in one file (a bad hand-merge, a crashed editor) would source the
  // integration twice; upsert must converge on ONE block, deterministically.
  const block = windowsBlock(join(homedir(), "shell", "agents.ps1"));
  const stale = `${MARKER}\n$AgentsPs1 = 'C:\\old\\agents.ps1'\n` +
    `if (Test-Path -LiteralPath $AgentsPs1) { . $AgentsPs1 }\n${MARKER_END}`;
  const content = `Write-Host before\n\n${stale}\n\nWrite-Host middle\n\n${stale}\n\n` +
    `Write-Host after\n`;
  const next = up(content, MARKER, block);
  expect(markerLines(next, MARKER)).toBe(1);
  // Refreshed IN PLACE at the first site: user lines keep their order around it.
  expect(next.indexOf("Write-Host before")).toBeLessThan(next.indexOf(MARKER));
  expect(next.indexOf(MARKER_END)).toBeLessThan(next.indexOf("Write-Host middle"));
  expect(next.indexOf("Write-Host middle")).toBeLessThan(next.indexOf("Write-Host after"));
  expect(next).not.toContain("C:\\old\\agents.ps1");
  expect(up(next, MARKER, block)).toBe(next); // and the result is idempotent
});

test("stripping a duplicate block never deletes a user line under its marker", () => {
  // The duplicate's extent is as conservative as removal's: an unrecognized line
  // under the second marker survives the dedupe -- and is REPORTED, the same
  // leftBehind contract stripBlocks gives removal, so the wire path warns too.
  const block = windowsBlock(join(homedir(), "shell", "agents.ps1"));
  const wired = up("Write-Host before\n", MARKER, block);
  const next = upsertBlock(`${wired}\n${MARKER}\nWrite-Host mine\n`, MARKER, block);
  expect(markerLines(next.content, MARKER)).toBe(1);
  expect(next.content).toContain("Write-Host mine");
  expect(next.leftBehind).toEqual(["Write-Host mine"]);
});

test("deduping a block at EOF preserves the file's (un)terminated state", () => {
  // A duplicate on the file's last line, with and without a final newline: the dedupe
  // must not add or drop the terminator (a string round-trip through stripBlocks
  // cannot tell "no tail" from "one empty terminator line").
  const block = windowsBlock(join(homedir(), "shell", "agents.ps1"));
  const wired = up("Write-Host before\n", MARKER, block);
  expect(up(`${wired}\n${MARKER}\n`, MARKER, block)).toBe(wired);
  expect(up(`${wired}\n${MARKER}`, MARKER, block)).toBe(wired.replace(/\n$/, ""));
});

test("a legacy (unfenced) first block still migrates when a fenced duplicate follows", () => {
  const legacy = `${MARKER}\nAGENTS_BASHRC="/old/agents.bashrc"\n` +
    `[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"`;
  const block = posixBlock(join(homedir(), "shell", "agents.bashrc"));
  const dup = block.slice(1); // the same fenced block, without its leading blank
  // A user line BETWEEN the legacy block and the fenced duplicate: the legacy
  // extent must stop before it and the dedupe must not eat it either.
  const next = upsertBlock(
    `${legacy}\nexport BETWEEN=1\n\n${dup}export AFTER=1\n`,
    MARKER,
    block,
  );
  expect(markerLines(next.content, MARKER)).toBe(1);
  expect(next.content).toContain(MARKER_END); // the FIRST site was refreshed to the fenced form
  expect(next.content).not.toContain("/old/agents.bashrc");
  expect(next.content.indexOf(MARKER_END)).toBeLessThan(next.content.indexOf("export BETWEEN=1"));
  expect(next.content.indexOf("export BETWEEN=1")).toBeLessThan(
    next.content.indexOf("export AFTER=1"),
  );
  expect(next.leftBehind).toEqual([]); // both lines sit OUTSIDE the owned extents
});

test("CRLF duplicates dedupe to one all-CRLF block", () => {
  const block = windowsBlock(join(homedir(), "shell", "agents.ps1"));
  const lf = up("Write-Host before\n", MARKER, block);
  const crlf = `${lf}\n${MARKER}\n`.replaceAll("\n", "\r\n");
  const next = up(crlf, MARKER, block);
  expect(markerLines(next, MARKER)).toBe(1);
  expect(next).not.toMatch(/[^\r]\n/); // no lone LF anywhere
  expect(up(next, MARKER, block)).toBe(next);
  // An UNTERMINATED duplicate at EOF: deduping it makes our block the new EOF, so its
  // last line must shed the \r that now has no \n to pair with.
  const unterm = up(`${lf}\n${MARKER}`.replaceAll("\n", "\r\n"), MARKER, block);
  expect(unterm).toBe(lf.replaceAll("\n", "\r\n").replace(/\r\n$/, ""));
  expect(up(unterm, MARKER, block)).toBe(unterm);
});

test("an unknown marker is unrepresentable, not a runtime throw", () => {
  // The shape lookup is typed against the marker union (BlockMarker), so a marker
  // this module does not own fails to compile; there is no throwing lookup left.
  void (() => {
    // @ts-expect-error -- not an owned block marker
    up("", "# some other marker", "");
    // @ts-expect-error -- not an owned block marker
    stripBlocks("", ["# some other marker"]);
  });
  expect(markerLines(`${MARKER}\n`, MARKER)).toBe(1);
});

test("upsert migrates a legacy PowerShell block (old Test-Path spelling) to the fenced format", () => {
  // Both historical guard spellings must be recognized: the pre-TS installers wrote
  // `Test-Path $AgentsPs1` (no -LiteralPath).
  const legacy = `${MARKER}\n$AgentsPs1 = "C:\\old\\agents.ps1"\n` +
    `if (Test-Path $AgentsPs1) { . $AgentsPs1 }`;
  const profile = `Write-Host before\n\n${legacy}\n\nWrite-Host after\n`;
  const next = up(profile, MARKER, windowsBlock(join(homedir(), "shell", "agents.ps1")));
  expect(next).toContain(MARKER_END);
  expect(next).not.toContain("C:\\old\\agents.ps1");
  expect(next.indexOf("Write-Host before")).toBeLessThan(next.indexOf(MARKER));
  expect(next.indexOf(MARKER_END)).toBeLessThan(next.indexOf("Write-Host after"));
});

test("stripBlocks removes an intact legacy PowerShell block but never a user line", () => {
  const legacy = `${MARKER}\n$AgentsPs1 = "C:\\x\\agents.ps1"\n` +
    `if (Test-Path -LiteralPath $AgentsPs1) { . $AgentsPs1 }`;
  const intact = stripBlocks(`Write-Host before\n\n${legacy}\nWrite-Host after\n`, [MARKER]);
  expect(intact.content).toBe("Write-Host before\nWrite-Host after\n");
  expect(intact.leftBehind).toEqual([]);

  // Hand-shortened: the guard line was deleted; the user's next line survives, reported.
  const shortened = stripBlocks(
    `${MARKER}\n$AgentsPs1 = "C:\\x\\agents.ps1"\n$env:IMPORTANT = 'keep'\n`,
    [MARKER],
  );
  expect(shortened.content).toBe("$env:IMPORTANT = 'keep'\n");
  expect(shortened.leftBehind).toEqual(["$env:IMPORTANT = 'keep'"]);

  // Hand-extended: a foreign line inside the block stops the cut and is reported.
  const extended = stripBlocks(
    `${MARKER}\n$AgentsPs1 = "C:\\x\\agents.ps1"\nWrite-Host mine\n` +
      `if (Test-Path -LiteralPath $AgentsPs1) { . $AgentsPs1 }\n`,
    [MARKER],
  );
  expect(extended.content).toContain("Write-Host mine");
  expect(extended.content).not.toContain(MARKER);
  expect(extended.content).not.toContain("$AgentsPs1 = ");
  expect(extended.leftBehind).toEqual(["Write-Host mine"]);

  // Each marker recognizes only ITS body: a launchers-shaped line under the main
  // marker is someone else's and stays put.
  const crossed = stripBlocks(`${MARKER}\n$AgentsLaunchers = 'C:\\x\\l.ps1'\n`, [MARKER]);
  expect(crossed.content).toBe("$AgentsLaunchers = 'C:\\x\\l.ps1'\n");
  expect(crossed.leftBehind).toEqual(["$AgentsLaunchers = 'C:\\x\\l.ps1'"]);
});

test("legacy recognition is ordered: a lookalike line in the guard position is spared", () => {
  // The user's own AGENTS_BASHRC= assignment right after ours matches the assignment
  // shape but sits where the guard belongs -- an unordered any-two-recognized-lines
  // scan would eat it.
  const stripped = stripBlocks(
    `${MARKER}\nAGENTS_BASHRC="/managed/agents.bashrc"\nAGENTS_BASHRC=/user-owned\nexport KEEP=1\n`,
    [MARKER],
  );
  expect(stripped.content).toBe("AGENTS_BASHRC=/user-owned\nexport KEEP=1\n");
  expect(stripped.leftBehind).toEqual(["AGENTS_BASHRC=/user-owned"]);
});

test("a shortened block abutting the next marker does not warn about that marker", () => {
  // The launchers marker stopping the main block's legacy scan is ours, not the
  // user's: it is removed as its own block, so reporting it "left in place" would lie.
  const content = `${MARKER}\nAGENTS_BASHRC="/x/agents.bashrc"\n` +
    `${LAUNCHERS_MARKER}\nAGENTS_LAUNCHERS="/x/l.bashrc"\n` +
    `[ -f "$AGENTS_LAUNCHERS" ] && source "$AGENTS_LAUNCHERS"\nexport AFTER=1\n`;
  const stripped = stripBlocks(content, [MARKER, LAUNCHERS_MARKER]);
  expect(stripped.content).toBe("export AFTER=1\n");
  expect(stripped.leftBehind).toEqual([]);
});

test("quotePosix / quotePowerShell escape embedded single quotes", () => {
  expect(quotePosix("a'b")).toBe("'a'\\''b'");
  expect(quotePowerShell("a'b")).toBe("'a''b'");
});

test("the Windows $PROFILE lookup honors the Documents redirect on every OS", () => {
  // The real lookup asks Windows itself where Documents is: unreachable from a POSIX
  // test and unredirectable on Windows. Under the redirect it is pure path math, so
  // resolving it here at all is the proof that PowerShell was never spawned.
  const documents = join(home, "Documents");
  withEnv(CI_PS_DOCUMENTS_DIR_ENV, documents, () => {
    // One filename per call, under each PowerShell edition's directory.
    expect(windowsProfileTarget(false).paths).toEqual([
      join(documents, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
      join(documents, "PowerShell", "Microsoft.PowerShell_profile.ps1"),
    ]);
    expect(windowsProfileTarget(true).paths).toEqual([
      join(documents, "WindowsPowerShell", "profile.ps1"),
      join(documents, "PowerShell", "profile.ps1"),
    ]);
    // Not the machine's own profile -- what stops the caller relaxing its policy.
    expect(windowsProfileTarget(false).source).toBe("redirected");
  });
});

test("a set-but-unusable seam value is refused by every resolver", () => {
  // Quietly falling back to the machine's real startup file is the one failure a seam
  // whose job is isolation must not have: an empty value is an unexpanded interpolation,
  // a relative one resolves off the cwd. Windows cannot hold an empty env var (it reads
  // back as unset), so that case is only assertable where the OS preserves it.
  const relative = ["Documents", "./Documents"];
  const bad = process.platform === "win32" ? relative : ["", ...relative];
  for (const value of bad) {
    withEnv(CI_PS_DOCUMENTS_DIR_ENV, value, () => {
      expect(() => windowsProfileTarget(false)).toThrow("must be an absolute path");
    });
    withEnv(CI_RC_DIR_ENV, value, () => {
      expect(() => rcFiles(true)).toThrow("must be an absolute path");
    });
  }
});

test("the POSIX rc lookup honors the rc-dir seam on every OS", () => {
  // homedir() does follow $HOME on POSIX, so this seam is not about reachability like its
  // Windows twin -- it is the floor that stops a test which forgot to isolate $HOME from
  // landing in the developer's real ~/.bashrc.
  const rcDir = join(home, "rc");
  mkdirSync(rcDir, { recursive: true });
  writeFileSync(join(rcDir, ".bashrc"), "export EXISTING=1\n");
  withEnv(CI_RC_DIR_ENV, rcDir, () => {
    expect(rcFiles(true)).toEqual([join(rcDir, ".bashrc")]);
    // With no rc file present the wiring path falls back to one named for $SHELL -- still
    // under the seam, never under $HOME.
    rmSync(join(rcDir, ".bashrc"));
    withEnv("SHELL", "/bin/zsh", () => {
      expect(rcFiles(false)).toEqual([join(rcDir, ".zshrc")]);
    });
    withEnv("SHELL", "/bin/bash", () => {
      expect(rcFiles(false)).toEqual([join(rcDir, ".bashrc")]);
    });
  });
});

skipWin("the rc-dir seam beats $HOME end to end, so a stray run cannot reach it", () => {
  // The structural floor: even with $HOME pointed at a live directory, the seam decides
  // where `agent shell` writes. This is what keeps a test that forgets its own isolation
  // from landing in the real ~/.bashrc.
  const rcDir = mkdtempSync(join(tmpdir(), "copilot-rc-"));
  try {
    const proc = runCli(["shell"], {
      env: {
        ...process.env,
        HOME: home,
        SHELL: "/bin/bash",
        CONSOLA_LEVEL: "5",
        [CI_RC_DIR_ENV]: rcDir,
      },
    });
    expect({ exitCode: proc.exitCode, stderr: proc.stderr }).toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(rcDir, ".bashrc"), "utf-8")).toContain(MARKER);
    expect(existsSync(join(home, ".bashrc"))).toBe(false); // $HOME never touched
  } finally {
    rmSync(rcDir, { recursive: true, force: true });
  }
});

// Windows only, and the one test that exercises the REAL lookup end to end: it spawns
// PowerShell and asks the OS where Documents is. It clears any inherited redirect first,
// or it would quietly stop testing the thing it exists for. Read-only -- it resolves
// paths and writes nothing, so it is safe against a real profile.
test.skipIf(process.platform !== "win32")(
  "the un-redirected Windows lookup resolves the machine's real $PROFILE candidates",
  () => {
    withEnv(CI_PS_DOCUMENTS_DIR_ENV, null, () => {
      const target = windowsProfileTarget(false); // resolving at all is the assertion
      expect(target.source).toBe("system");
      expect(target.paths.length).toBe(2);
      for (const path of target.paths) {
        expect(basename(path)).toBe("Microsoft.PowerShell_profile.ps1");
        // GetFolderPath answered with a real location, not "" and not a bare name.
        expect(isAbsolute(path)).toBe(true);
      }
    });
  },
);

test("windows execution policy command skips unavailable policy cmdlets", () => {
  const command = windowsExecutionPolicyCommand();
  expect(command).toContain("Get-Command Get-ExecutionPolicy -ErrorAction Stop");
  expect(command).toContain("Get-Command Set-ExecutionPolicy -ErrorAction Stop");
  expect(command).toContain("catch");
  expect(command).toContain("exit 0");
  // Desktop (5.1) inherits pwsh's PSModulePath when spawned from pwsh and the policy cmdlets
  // fail to autoload; reset it to the machine default so they resolve. Core is left alone.
  expect(command).toContain("$PSVersionTable.PSEdition -eq 'Desktop'");
  expect(command).toContain("[Environment]::GetEnvironmentVariable('PSModulePath','Machine')");
  expect(command).toContain(
    "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force",
  );
});

test("the PowerShell agent wrapper evals every env line, mirroring the POSIX eval", () => {
  // agents.bashrc evals the whole `agent env` output unconditionally; the PS
  // wrapper must do the same (Invoke-Expression on every non-blank line, no
  // shape-matching filter), so a new upstream directive shape is never
  // silently dropped on Windows.
  const ps1 = readFileSync(join(process.cwd(), "shell", "agents.ps1"), "utf8");
  expect(ps1).toContain("Invoke-Expression");
  expect(ps1).not.toContain("$line -match");
});

test("env-refresh stderr parity: eager source is silenced, the agent wrapper's refresh is not (POSIX)", () => {
  const posix = readFileSync(join(process.cwd(), "shell", "agents.bashrc"), "utf8");

  // The eager startup `agent env` call silences stderr so bootstrap noise
  // doesn't break the prompt's instant-prompt guard. It forwards NO arguments
  // (matching the ps1 twin's eager Import-CopilotEnv -Quiet).
  expect(posix).toMatch(/bin\/agent" env 2>\/dev\/null/);

  // The `agent` wrapper's refresh must NOT silence stderr -- a genuine failure
  // should stay visible. Assert the refresh line and that it carries no redirect.
  const body = shellFunctionBody(posix, "agent");
  const refresh = body.split("\n").find((line) => line.includes('bin/agent" env)'));
  expect(refresh).toBeDefined();
  expect(refresh).toMatch(/_env="\$\("\$\{_COPILOT_AGENTS_DIR\}\/bin\/agent" env\)" && eval/);
  expect(refresh).not.toContain("2>/dev/null");
});

test("env-refresh stderr parity: Import-CopilotEnv takes -Quiet, eager passes it, the agent wrapper omits it (PowerShell)", () => {
  const powershell = readFileSync(join(process.cwd(), "shell", "agents.ps1"), "utf8");

  // Import-CopilotEnv declares a [switch]$Quiet param that gates the 2>$null redirect.
  expect(powershell).toMatch(/function Import-CopilotEnv\s*\{\s*param\(\[switch\]\$Quiet\)/);
  expect(powershell).toMatch(/if \(\$Quiet\) \{ Invoke-Agent env --format powershell 2>\$null \}/);

  // The eager startup call passes -Quiet to silence bootstrap noise.
  expect(powershell).toMatch(/Import-CopilotEnv -Quiet/);

  // The `agent` wrapper calls Import-CopilotEnv WITHOUT -Quiet so a real
  // refresh failure stays visible (mirrors the POSIX unsilenced refresh).
  const agentBody = shellFunctionBody(powershell, "agent");
  const refresh = agentBody.split("\n").find((line) => line.includes("Import-CopilotEnv"));
  expect(refresh).toBeDefined();
  expect(refresh?.trim()).toBe("Import-CopilotEnv");
  expect(refresh).not.toContain("-Quiet");
});

// The seam NAMES are external contracts: the suite floor (test/helpers/testing.ts) exports
// them into every test process, and a child spawned with a hand-built env spells them as
// literals. Pin the exported constants to those literals so a rename fails here instead of
// silently orphaning a hand-spelled seam; asserting the live env also proves the floor is
// active in this very process.
test("the sandbox floor sets both shell seams under their exported names", () => {
  expect(CI_RC_DIR_ENV).toBe("COPILOT_ENV_CI_RC_DIR");
  expect(CI_PS_DOCUMENTS_DIR_ENV).toBe("COPILOT_ENV_CI_PS_DOCUMENTS_DIR");
  expect(Deno.env.get(CI_RC_DIR_ENV)).toBeDefined();
  expect(Deno.env.get(CI_PS_DOCUMENTS_DIR_ENV)).toBeDefined();
});
