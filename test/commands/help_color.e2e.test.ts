// What would drift silently: bright black (SGR 90) is a legal color that a dark terminal theme
// draws almost on its background, so help painted with it passes every text assertion and cannot
// be read. Only a real terminal turns the colors on, hence the pty.

import { bunRunArgs, CLI_ENTRY, spawnChild } from "../helpers/run.ts";
import { expect, test } from "../helpers/testing.ts";

/** ESC then `[`, the introducer of every color code. */
const CSI = `${String.fromCharCode(27)}[`;

/** Bun.Terminal, a pty, exists on POSIX alone. */
const onPosix = test.skipIf(process.platform === "win32");

/** Every byte `agent <args>` writes to a terminal that takes color. */
async function paintedScreen(args: string[]): Promise<string> {
  const chunks: Buffer[] = [];
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 50,
    data: (_terminal, data) => {
      chunks.push(Buffer.from(data));
    },
  });
  try {
    const child = spawnChild(process.execPath, {
      args: [...bunRunArgs(), CLI_ENTRY, ...args],
      // The three keys that turn color off under a test run (src/utils/ansi.ts).
      env: { NO_COLOR: undefined, TEST: undefined, CI: undefined, TERM: "xterm-256color" },
      terminal,
    });
    await child.exited;
  } finally {
    terminal.close();
  }
  return Buffer.concat(chunks).toString("utf8");
}

onPosix(
  "help on a color terminal paints its descriptions dim on the default foreground, never bright black",
  async () => {
    for (const args of [["--help"], ["profile", "--help"]]) {
      const screen = await paintedScreen(args);
      expect(screen, `agent ${args.join(" ")}`).toContain(`${CSI}2m`);
      expect(screen, `agent ${args.join(" ")}`).not.toContain(`${CSI}90m`);
    }
  },
);
