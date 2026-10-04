import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, sep } from "node:path";
import {
  CI_PS_DOCUMENTS_DIR_ENV,
  CI_RC_DIR_ENV,
  MARKER_END,
  posixBlock,
  rcFiles,
  stripBlocks,
  upsertBlock,
  windowsBlock,
  windowsProfileTarget,
} from "../src/shell/integration.ts";
import { quotePosix, quotePowerShell } from "../src/utils/shell_quote.ts";
import { ROOT, runCli, runSync } from "./helpers/run.ts";
import { afterEach, beforeEach, expect, tempDir, test } from "./helpers/testing.ts";

// The POSIX path runs the real CLI under a throwaway $HOME so the real rc files are never touched.

const MARKER = "# copilot-env shell integration";
// On win32 the command takes the Windows code path (writes the PS $PROFILE, not an
// rc file), so these POSIX-behavior tests only run off Windows.
const skipWin = test.skipIf(process.platform === "win32");
let home = "";

/** upsertBlock's content, for the round-trip assertions that don't inspect leftBehind. */
function up(content: string, block: string): string {
  return upsertBlock(content, block).content;
}

/** Occurrences of `marker` as a whole line. The end markers contain the open markers
 *  as substrings, so substring counting would double-count a fenced block. */
function markerLines(content: string, marker: string): number {
  return content.split("\n").filter((l) => l.replace(/\r$/, "") === marker).length;
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
  home = tempDir("copilot-si-");
});
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

skipWin(
  "a fresh wire creates the rc with ONE fenced block, end fence + ONE blank last, and a second wire is byte-for-byte identical",
  () => {
    expect(run().code).toBe(0);
    const rc = readFileSync(join(home, ".bashrc"), "utf-8");
    expect(rc).toContain("agents.bashrc");
    expect(markerLines(rc, MARKER)).toBe(1);
    // The fence spellings are an on-disk contract: every installed rc carries these lines, so a
    // respelling would orphan the blocks already written.
    expect(rc).toContain(`\n${MARKER}\n`);
    expect(rc.endsWith("# copilot-env shell integration end\n\n")).toBe(true);
    expect(rc.endsWith(`${MARKER_END}\n\n\n`)).toBe(false); // no trailing-blank pileup at EOF
    run();
    expect(readFileSync(join(home, ".bashrc"), "utf-8")).toBe(rc);
  },
);

skipWin(
  "re-wiring refreshes a stale block in place: the current shell/ path, ONE blank before the user's next line, later lines unmoved, re-runs converge",
  () => {
    const stale = `${MARKER}\nAGENTS_BASHRC="/old/agents.bashrc"\n` +
      `[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\n${MARKER_END}`;
    const rows: Array<{ before: string; above: string; below: string | null }> = [
      // The motivating rc shape: a stale block sits directly against the user's next line.
      {
        before: `# ---- Agent environments ----\n${stale}\nexport PATH="/opt/x/bin:$PATH"\n`,
        above: "# ---- Agent environments ----",
        below: 'export PATH="/opt/x/bin:$PATH"',
      },
      {
        before: `export BEFORE=1\n\n${stale}\n\nexport AFTER=1\n`,
        above: "export BEFORE=1",
        below: "export AFTER=1",
      },
      { before: `export KEEP=1\n\n${stale}\n`, above: "export KEEP=1", below: null },
    ];
    for (const { before, above, below } of rows) {
      writeFileSync(join(home, ".bashrc"), before);
      expect(run().code, before).toBe(0);
      const rc = readFileSync(join(home, ".bashrc"), "utf-8");
      expect(rc, before).toContain("shell/agents.bashrc");
      expect(rc, before).not.toContain("/old/agents.bashrc");
      expect(markerLines(rc, MARKER), before).toBe(1);
      // The user's lines survive the rewire in place: indexOf alone would read a deleted
      // line as -1 and still order before the marker.
      expect(rc, before).toContain(above);
      expect(rc.indexOf(above), before).toBeLessThan(rc.indexOf(MARKER));
      if (below !== null) expect(rc, before).toContain(`${MARKER_END}\n\n${below}`);
      expect(rc, before).not.toContain(`${MARKER_END}\n\n\n`);
      // Re-runs REUSE the owned blank, never stack another.
      run();
      expect(readFileSync(join(home, ".bashrc"), "utf-8"), before).toBe(rc);
    }
  },
);

skipWin("wire then --remove restores the rc byte-for-byte, owned blanks included", () => {
  const original = "export BEFORE=1\n\nexport AFTER=1\n";
  writeFileSync(join(home, ".bashrc"), original);
  expect(run().code).toBe(0);
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).not.toBe(original);
  expect(run("--remove").code).toBe(0);
  expect(readFileSync(join(home, ".bashrc"), "utf-8")).toBe(original);
});

/** The stored `launchers` config key, read from the per-test store run() points
 *  COPILOT_API_HOME at. */
function storedLaunchersKey(): boolean | undefined {
  const file = join(home, "state.json");
  if (!existsSync(file)) return undefined;
  return (JSON.parse(readFileSync(file, "utf-8")) as { global?: { "shell.launchers"?: boolean } })
    .global?.["shell.launchers"];
}

skipWin(
  "--remove strips a CRLF-written legacy block and a fresh fenced wire alike; the launchers key stays the user's",
  () => {
    // A block written with CRLF (an old PowerShell Add-Content, a CRLF rc), without an end fence.
    const crlfLegacy = `export KEEP=1\r\n\r\n${MARKER}\r\nAGENTS_BASHRC="/x/agents.bashrc"\r\n` +
      `[ -f "$AGENTS_BASHRC" ] && source "$AGENTS_BASHRC"\r\n`;
    const rows: Array<
      { stage: () => void; survives: string | null; launchers: boolean | undefined }
    > = [
      {
        stage: () => writeFileSync(join(home, ".bashrc"), crlfLegacy),
        survives: "export KEEP=1",
        launchers: undefined,
      },
      {
        stage: () => {
          run();
          writeFileSync(
            join(home, "state.json"),
            JSON.stringify({ global: { "shell.launchers": true } }),
          );
        },
        survives: null,
        launchers: true,
      },
    ];
    for (const { stage, survives, launchers } of rows) {
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home);
      stage();
      expect(run("--remove").code).toBe(0);
      const rc = readFileSync(join(home, ".bashrc"), "utf-8");
      expect(rc).not.toContain(MARKER);
      if (survives !== null) expect(rc).toContain(survives);
      expect(storedLaunchersKey()).toBe(launchers);
    }
  },
);

skipWin("shell wires NO launchers block and reports the launchers key without writing it", () => {
  // The launchers are `agent profile env` emissions gated on the `launchers` config key; the
  // rc file carries only the integration block, and `--launchers` is no flag.
  const wired = run();
  expect(wired.code).toBe(0);
  expect(wired.out).toContain("Launchers: disabled (the shell.launchers config key)");
  const rc = readFileSync(join(home, ".bashrc"), "utf-8");
  expect(rc).toContain(MARKER);
  expect(markerLines(rc, MARKER)).toBe(1);
  expect(storedLaunchersKey()).toBeUndefined();
  const rejected = run("--launchers");
  expect(rejected.code).toBe(1);
  expect(rejected.out).toContain("unknown option");
});

skipWin("posixBlock safely quotes paths with shell metacharacters", () => {
  // Sourcing under real bash is the proof: the path must come back as the exact literal.
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
  // The rc file travels (dotfile syncs, renamed users), so the block must follow $HOME. A tail
  // with double-quote metacharacters falls back to "$HOME"'<tail>' so only $HOME expands;
  // sourcing under a DIFFERENT $HOME is the proof.
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
  // Parity with posixBlock: a profile synced across machines must follow $HOME.
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

test("upsert follows the file's DOMINANT line ending on a first wire, and keeps a CRLF block all-CRLF through refresh, dedupe, and EOF normalization", () => {
  const block = windowsBlock(join(homedir(), "shell", "agents.ps1"));
  const crlfBlock = block.replaceAll("\n", "\r\n");
  const lfWired = `Write-Host before\n${block}`;
  const crlfWired = lfWired.replaceAll("\n", "\r\n");
  const rows: Array<[string, string]> = [
    // Only the REFRESH path once preserved CRLF: a first append into a Notepad-written
    // $PROFILE left LF lines in a CRLF file.
    ["Write-Host before\r\n", crlfWired],
    // A refresh never flips a CRLF block's endings: that would be a spurious diff on every
    // re-wire.
    [crlfWired, crlfWired],
    // A CRLF file ending INSIDE the block's owned region (its separating blank lost its final
    // newline) normalizes back: never a lone \r at EOF, never a stacked blank.
    [crlfWired.replace(/\r\n$/, ""), crlfWired],
    // The DOMINANT ending decides, not any stray one; a tie stays LF like an empty (or new)
    // file: the builders' platform-neutral form.
    ["a\nb\nc\r\nd\n", `a\nb\nc\r\nd\n${block}`],
    ["a\r\nb\r\nc\nd\r\n", `a\r\nb\r\nc\nd\r\n${crlfBlock}`],
    ["a\r\nb\n", `a\r\nb\n${block}`],
    ["", block],
    ["a\r\nb", `a\r\nb${crlfBlock}`],
    // CRLF duplicates at EOF, terminated and not, dedupe to the ONE all-CRLF wired form.
    [`${lfWired}\n${MARKER}\n`.replaceAll("\n", "\r\n"), crlfWired],
    [`${lfWired}\n${MARKER}`.replaceAll("\n", "\r\n"), crlfWired],
  ];
  for (const [content, wired] of rows) {
    expect(up(content, block), JSON.stringify(content)).toBe(wired);
    expect(up(wired, block), JSON.stringify(content)).toBe(wired);
  }
  const removed = stripBlocks(crlfWired);
  expect(removed.content).toBe("Write-Host before\r\n");
  expect(removed.leftBehind).toEqual([]);
});

test("upsert converges duplicate blocks on ONE wherever they sit: the first refreshed, the rest stripped, a user line under a stray marker kept and reported, an EOF duplicate normalized", () => {
  const block = windowsBlock(join(homedir(), "shell", "agents.ps1"));
  const wired = up("Write-Host before\n", block);
  const stale = `${MARKER}\n$AgentsPs1 = 'C:\\old\\agents.ps1'\n` +
    `if (Test-Path -LiteralPath $AgentsPs1) { . $AgentsPs1 }\n${MARKER_END}`;
  const rows: Array<{ content: string; converged: string; leftBehind: string[] }> = [
    // Two markers in one file (a bad hand-merge, a crashed editor) would source the
    // integration twice.
    {
      content:
        `Write-Host before\n\n${stale}\n\nWrite-Host middle\n\n${stale}\n\nWrite-Host after\n`,
      converged: `${wired}Write-Host middle\nWrite-Host after\n`,
      leftBehind: [],
    },
    // The duplicate's extent is as conservative as removal's: an unrecognized line under the
    // second marker survives and is REPORTED, the same leftBehind contract stripBlocks gives
    // removal, so the wire path warns too.
    {
      content: `${wired}\n${MARKER}\nWrite-Host mine\n`,
      converged: `${wired}Write-Host mine\n`,
      leftBehind: ["Write-Host mine"],
    },
    // A duplicate on the last line, with and without a final newline: both ends of the junk
    // sit inside owned territory, so the dedupe normalizes back to the ONE EOF shape an
    // append writes (end fence, one blank, final newline) instead of flip-flopping the
    // terminator or stacking blanks.
    { content: `${wired}\n${MARKER}\n`, converged: wired, leftBehind: [] },
    { content: `${wired}\n${MARKER}`, converged: wired, leftBehind: [] },
  ];
  for (const { content, converged, leftBehind } of rows) {
    const next = upsertBlock(content, block);
    expect(next.content, content).toBe(converged);
    expect(next.leftBehind, content).toEqual(leftBehind);
    expect(up(next.content, block), content).toBe(next.content);
  }
});

test("upsert owns ONE separating blank: added once, reused forever, at EOF and before a user line; extra user spacing stays", () => {
  const block = posixBlock(join(homedir(), "shell", "agents.bashrc"));
  const wired = `A=1\n${block}`;
  // `snug` is a pre-blank release's wire: the end fence directly against the user's next line.
  const snug = `A=1\n${block.slice(1, -1)}B=1\n`;
  const migrated = `A=1\n${block.slice(1)}B=1\n`;
  // A user's own extra blank beyond the owned one is their spacing.
  const spaced = `A=1\n${block.slice(1)}\nB=1\n`;
  const rows: Array<[string, string]> = [
    [snug, migrated],
    [migrated, migrated],
    [spaced, spaced],
    ["A=1\n", wired],
    // The blank-less EOF shapes older releases wrote, fence-terminated and unterminated.
    [`A=1\n${block.slice(0, -1)}`, wired],
    [`A=1\n${block.trimEnd()}`, wired],
    [wired, wired],
  ];
  for (const [content, expected] of rows) {
    expect(up(content, block), JSON.stringify(content)).toBe(expected);
  }
});

test("removal owns ONE separating blank: the reused blank goes, extra user spacing stays", () => {
  const fenced = posixBlock(join(homedir(), "shell", "agents.bashrc")).slice(1);
  const wired = `export A=1\n\n${fenced}export B=1\n`;
  expect(stripBlocks(wired).content).toBe("export A=1\nexport B=1\n");
  const spaced = `export A=1\n\n${fenced}\nexport B=1\n`;
  expect(stripBlocks(spaced).content).toBe("export A=1\n\nexport B=1\n");
  // A fenced block with NO trailing blank (pre-blank releases) must not eat the adjacent line.
  const snug = `export A=1\n${fenced.replace(/\n$/, "")}export B=1\n`;
  expect(stripBlocks(snug).content).toBe("export A=1\nexport B=1\n");
  expect(stripBlocks(`export A=1\n\n${fenced}`).content).toBe("export A=1\n");
});

test("an unfenced block (the 3.5.6 shape) is not recognized: only its marker line is owned", () => {
  // The 4.0.0 migration fences these in place; a block it never reached is a bare
  // marker to the writer, and the body under it is the user's -- reported, never cut.
  const unfenced = stripBlocks(
    `Write-Host before\n\n${MARKER}\n$AgentsPs1 = "C:\\x\\agents.ps1"\n` +
      `if (Test-Path -LiteralPath $AgentsPs1) { . $AgentsPs1 }\nWrite-Host after\n`,
  );
  expect(unfenced.content).toBe(
    `Write-Host before\n$AgentsPs1 = "C:\\x\\agents.ps1"\n` +
      `if (Test-Path -LiteralPath $AgentsPs1) { . $AgentsPs1 }\nWrite-Host after\n`,
  );
  expect(unfenced.leftBehind).toEqual(['$AgentsPs1 = "C:\\x\\agents.ps1"']);
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
  const rcDir = tempDir("copilot-rc-");
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
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
  } finally {
    rmSync(rcDir, { recursive: true, force: true });
  }
});

// Windows only: it spawns PowerShell and asks the OS where Documents is, so an inherited
// redirect is cleared first or it would quietly stop testing the real lookup. Read-only: it
// resolves paths and writes nothing, so it is safe against a real profile.
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

// The rc files locate `bin/agent` from their own path, so each copy is staged in a scratch
// `shell/` beside a fake agent. The failing mode's 99 is a count no run of evals reaches, so an
// eval of a failed refresh's output is unmistakable. `fail` is a command that exits with its own
// status, 13, which no refresh exit shares.
const FAKE_AGENT_SH = `#!/bin/sh
echo "fake agent stderr: $*" >&2
if [ "$1" = profile ] && [ "$2" = env ]; then
  if [ -n "\${COPILOT_FAKE_REFRESH_FAILS:-}" ]; then
    echo "export COPILOT_FAKE_REFRESHES=99"
    exit 7
  fi
  echo "export COPILOT_FAKE_REFRESHES=$((\${COPILOT_FAKE_REFRESHES:-0} + 1))"
  echo "export COPILOT_FAKE_ARGS='$*'"
  echo "unset COPILOT_FAKE_STALE"
  echo 'fake_launcher() { echo "fake launcher ran"; }'
elif [ "$1" = fail ]; then
  exit 13
else
  echo "fake agent stdout: $*"
fi
`;
const FAKE_AGENT_PS1 = `[Console]::Error.WriteLine("fake agent stderr: $($args -join ' ')")
if ($args.Count -ge 2 -and $args[0] -eq 'profile' -and $args[1] -eq 'env') {
  if ($env:COPILOT_FAKE_REFRESH_FAILS) {
    "\`$env:COPILOT_FAKE_REFRESHES = '99'"
    exit 7
  }
  "\`$env:COPILOT_FAKE_REFRESHES = '$([int]$env:COPILOT_FAKE_REFRESHES + 1)'"
  "\`$env:COPILOT_FAKE_ARGS = '$($args -join ' ')'"
  "Remove-Item -LiteralPath Env:COPILOT_FAKE_STALE -ErrorAction SilentlyContinue"
  "function global:fake_launcher { 'fake launcher ran' }"
} elseif ($args[0] -eq 'fail') {
  exit 13
} else {
  "fake agent stdout: $($args -join ' ')"
}
`;

function stageRc(rc: string, agent: string, fake: string): { root: string; rc: string } {
  const root = tempDir("copilot-rc-eval-");
  mkdirSync(join(root, "shell"));
  mkdirSync(join(root, "bin"));
  copyFileSync(join(ROOT, "shell", rc), join(root, "shell", rc));
  writeFileSync(join(root, "bin", agent), fake);
  chmodSync(join(root, "bin", agent), 0o755);
  return { root, rc: join(root, "shell", rc) };
}

const onPath = (exe: string): boolean =>
  (process.env.PATH ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, exe)));

// The rc is sourced from .bashrc and .zshrc alike, so a bash-only construct must fail here under
// zsh, not on the first macOS login shell that sources it.
for (const shell of ["bash", "zsh"]) {
  test.skipIf(process.platform === "win32" || !onPath(shell))(
    `agents.bashrc under ${shell} evals \`agent profile env\` silently at source time and audibly ` +
      "after every `agent` call, evals nothing from a failed resolution, whether it failed at " +
      "source time or on a refresh, reports the command's own status whether the refresh or the " +
      "command failed, and leaves the user's own variables alone",
    () => {
      const staged = stageRc("agents.bashrc", "agent", FAKE_AGENT_SH);
      // `_env` is a name a user's own rc plausibly holds; the rc's temporaries live in its
      // reserved `_COPILOT_` namespace, so sourcing must not assign or unset it.
      const proc = runSync(shell, [
        "-c",
        [
          "_env=keep",
          'source "$1"',
          'echo "after source: $COPILOT_FAKE_REFRESHES $COPILOT_FAKE_ARGS stale=${COPILOT_FAKE_STALE-unset} _env=${_env-unset}"',
          "fake_launcher",
          "agent hello",
          'echo "after agent: $COPILOT_FAKE_REFRESHES"',
          "export COPILOT_FAKE_REFRESH_FAILS=1",
          "agent again",
          'echo "after failed refresh: $COPILOT_FAKE_REFRESHES status=$?"',
          "agent fail",
          'echo "after failed command: $COPILOT_FAKE_REFRESHES status=$?"',
        ].join("\n"),
        shell,
        staged.rc,
      ], { env: { ...process.env, HOME: home, COPILOT_FAKE_STALE: "1" } });
      expect({ exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr }).toEqual({
        exitCode: 0,
        stdout: "after source: 1 profile env stale=unset _env=keep\nfake launcher ran\n" +
          "fake agent stdout: hello\nafter agent: 2\n" +
          "fake agent stdout: again\nafter failed refresh: 2 status=0\n" +
          "after failed command: 2 status=13\n",
        stderr: "fake agent stderr: hello\nfake agent stderr: profile env\n" +
          "fake agent stderr: again\nfake agent stderr: profile env\n" +
          "fake agent stderr: fail\n",
      });
      const failed = runSync(shell, [
        "-c",
        'source "$1"\necho "after failed source: ${COPILOT_FAKE_REFRESHES-unset}"',
        shell,
        staged.rc,
      ], { env: { ...process.env, HOME: home, COPILOT_FAKE_REFRESH_FAILS: "1" } });
      expect({ exitCode: failed.exitCode, stdout: failed.stdout, stderr: failed.stderr }).toEqual({
        exitCode: 0,
        stdout: "after failed source: unset\n",
        stderr: "",
      });
    },
  );
}

// The driver is the host that dot-sources agents.ps1 and the host its nested `agent` call
// re-enters, so a pwsh-only construct in the rc fails under Windows PowerShell 5.1 here, on the
// Windows runner, instead of in a user's $PROFILE.
const PS_DRIVERS = [
  { driver: "pwsh", onThisHost: onPath(process.platform === "win32" ? "pwsh.exe" : "pwsh") },
  { driver: "powershell", onThisHost: process.platform === "win32" },
];

for (const { driver: ps, onThisHost } of PS_DRIVERS) {
  test.skipIf(!onThisHost)(
    `agents.ps1 under ${ps} evals every \`agent profile env\` line, -Quiet at dot-source time and ` +
      "audibly after every `agent` call, evals nothing from a failed resolution, whether it " +
      "failed at dot-source time or on a refresh, and reports the command's own status whether " +
      "the refresh or the command failed",
    () => {
      const staged = stageRc("agents.ps1", "agent.ps1", FAKE_AGENT_PS1);
      const driver = join(staged.root, "driver.ps1");
      writeFileSync(
        driver,
        [
          ". $args[0]",
          '"after source: $env:COPILOT_FAKE_REFRESHES $env:COPILOT_FAKE_ARGS stale=[$env:COPILOT_FAKE_STALE]"',
          "fake_launcher",
          "agent hello",
          '"after agent: $env:COPILOT_FAKE_REFRESHES"',
          "$env:COPILOT_FAKE_REFRESH_FAILS = '1'",
          "agent again",
          '"after failed refresh: $env:COPILOT_FAKE_REFRESHES status=$LASTEXITCODE"',
          "agent fail",
          '"after failed command: $env:COPILOT_FAKE_REFRESHES status=$LASTEXITCODE"',
        ].join("\n"),
      );
      const proc = runSync(ps, ["-NoProfile", "-NonInteractive", "-File", driver, staged.rc], {
        env: { ...process.env, HOME: home, COPILOT_FAKE_STALE: "1" },
      });
      const lf = (text: string) => text.replaceAll("\r\n", "\n");
      expect({ exitCode: proc.exitCode, stdout: lf(proc.stdout), stderr: lf(proc.stderr) }).toEqual(
        {
          exitCode: 0,
          stdout: "after source: 1 profile env --format powershell stale=[]\nfake launcher ran\n" +
            "fake agent stdout: hello\nafter agent: 2\n" +
            "fake agent stdout: again\nafter failed refresh: 2 status=0\n" +
            "after failed command: 2 status=13\n",
          stderr: "fake agent stderr: hello\nfake agent stderr: profile env --format powershell\n" +
            "fake agent stderr: again\nfake agent stderr: profile env --format powershell\n" +
            "fake agent stderr: fail\n",
        },
      );
      const failedDriver = join(staged.root, "failed.ps1");
      writeFileSync(
        failedDriver,
        '. $args[0]\n"after failed source: [$env:COPILOT_FAKE_REFRESHES]"\n',
      );
      const failed = runSync(ps, [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        failedDriver,
        staged.rc,
      ], { env: { ...process.env, HOME: home, COPILOT_FAKE_REFRESH_FAILS: "1" } });
      expect({ exitCode: failed.exitCode, stdout: lf(failed.stdout), stderr: lf(failed.stderr) })
        .toEqual({ exitCode: 0, stdout: "after failed source: []\n", stderr: "" });
    },
  );
}
