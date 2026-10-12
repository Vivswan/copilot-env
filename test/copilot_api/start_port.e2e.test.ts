// resolveStartPort, the start's port decision, alone in its file: its busy-port rows hold a real
// loopback listener while the probe connects to it, and a Bun 1.4.2 Windows crash in that
// listener's teardown (a segfault draining a nextTick after a server-side socket's end) must not
// take the daemon tests down with it.
import { CopilotEnvConfig, type GlobalPatch } from "../../src/copilot_api/env_config.ts";
import { resolveStartPort } from "../../src/copilot_api/launch.ts";
import { parseProfileName } from "../../src/copilot_api/profile.ts";
import { CopilotEnvRunState } from "../../src/copilot_api/run_state.ts";
import { defaultHomeDir, envSnapshot, isolateProxyHome } from "../helpers/env.ts";
import { writeRunState } from "../helpers/fixtures.ts";
import { closeServer, freePort, listenEphemeral } from "../helpers/net.ts";
import { afterEach, expect, removeDir, test } from "../helpers/testing.ts";

const WORK = parseProfileName("work");

const restoreEnv = envSnapshot();
let dir = "";

afterEach(() => {
  restoreEnv();
});

/** The DEFAULT daemon's home under the isolated root `dir`, created on disk. */
function tmpHome(): string {
  dir = isolateProxyHome("copilot-start-port-");
  return defaultHomeDir();
}

async function withBusyPort<T>(run: (port: number) => Promise<T>): Promise<T> {
  const { server, port } = await listenEphemeral();
  try {
    return await run(port);
  } finally {
    await closeServer(server);
  }
}

// (config, requested port) -> the range error naming the fix. A wrong row is a start that silently
// picks a port outside the operator's range.
test("resolveStartPort: a port outside the configured range is a clear error, whichever side asks", async () => {
  const rows: Array<{ config: GlobalPatch; requested: number | undefined; error: string }> = [
    {
      config: { "daemon.min-port": 5000, "daemon.max-port": 4000 },
      requested: undefined,
      error:
        "invalid port range: daemon.min-port (5000) is greater than daemon.max-port (4000); fix it with " +
        "`agent config set daemon.min-port <n>` / `agent config set daemon.max-port <n>`.",
    },
    {
      config: { "daemon.min-port": 4000, "daemon.max-port": 5000 },
      requested: 3999,
      error:
        "requested port 3999 is out of range; the proxy port must be between 4000 and 5000 " +
        "(`agent config set daemon.min-port <n>` / `agent config set daemon.max-port <n>` change the range).",
    },
    {
      config: { "daemon.port": 1500, "daemon.min-port": 2000, "daemon.max-port": 3000 },
      requested: undefined,
      error:
        "configured port 1500 is outside the allowed range 2000-3000; run " +
        "`agent config set daemon.port <n>` within the range, or adjust daemon.min-port/daemon.max-port.",
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    tmpHome();
    new CopilotEnvConfig().set(row.config);
    await expect(
      resolveStartPort(row.requested, false, null, false, new CopilotEnvConfig()),
    ).rejects.toThrow(row.error);
  }
});

// (pinned or configured default, busy or free, strict-port) -> the port used or the refusal. A wrong
// row moves a start off its pinned port, or auto-increments where the operator forbade it.
test("resolveStartPort: a pin is used or refused as-is; a busy default moves unless strict-port forbids it", async () => {
  const rows: Array<{
    name: string;
    pinned: boolean;
    busy: boolean;
    strict: boolean;
    outcome: "same" | "moved" | ((port: number) => string);
  }> = [
    { name: "pinned free port", pinned: true, busy: false, strict: false, outcome: "same" },
    {
      name: "pinned busy port",
      pinned: true,
      busy: true,
      strict: false,
      outcome: (busy) =>
        `requested port ${busy} is busy (held by another process). Free it or pick another --port.`,
    },
    {
      name: "busy default under strict-port",
      pinned: false,
      busy: true,
      strict: true,
      outcome: (busy) =>
        `port ${busy} is busy and auto-increment is disabled (\`daemon.strict-port\`); free it, pick another \`--port\`, or set \`agent config set daemon.strict-port false\`.`,
    },
    {
      name: "busy default without strict-port",
      pinned: false,
      busy: true,
      strict: false,
      outcome: "moved",
    },
  ];
  for (const row of rows) {
    dir = removeDir(dir);
    tmpHome();
    const run = async (port: number): Promise<void> => {
      if (!row.pinned) {
        new CopilotEnvConfig().set({
          "daemon.port": port,
          ...(row.strict ? { "daemon.strict-port": true } : {}),
        });
      }
      const resolved = resolveStartPort(
        row.pinned ? port : undefined,
        false,
        null,
        false,
        new CopilotEnvConfig(),
      );
      if (typeof row.outcome === "function") {
        await expect(resolved).rejects.toThrow(row.outcome(port));
        return;
      }
      const chosen = await resolved;
      if (row.outcome === "same") {
        expect({ name: row.name, chosen }).toEqual({ name: row.name, chosen: port });
      } else {
        expect(chosen).not.toBe(port);
        expect(chosen).toBeGreaterThan(port);
      }
    };
    if (row.busy) await withBusyPort(run);
    else await run(await freePort());
  }
});

test("resolveStartPort: a named profile's reservation is honored, even after the range narrowed past it", async () => {
  tmpHome();
  const reserved = await freePort();
  expect(reserved).toBeGreaterThan(2048); // OS ephemeral ports sit far above the narrowed range
  writeRunState({ port: reserved }, WORK);
  expect(await resolveStartPort(undefined, false, WORK, false, new CopilotEnvConfig())).toBe(
    reserved,
  );
  // Out of range now: the reservation gets a liveness-only probe, no range check.
  new CopilotEnvConfig().set({ "daemon.min-port": 1024, "daemon.max-port": 2048 });
  expect(await resolveStartPort(undefined, false, WORK, false, new CopilotEnvConfig())).toBe(
    reserved,
  );
});

test("resolveStartPort: strict-port is DEFAULT-daemon-only -- a profile's busy reservation still moves", async () => {
  tmpHome();
  await withBusyPort(async (busy) => {
    new CopilotEnvConfig().set({ "daemon.strict-port": true });
    writeRunState({ port: busy }, WORK);
    const resolved = await resolveStartPort(undefined, false, WORK, false, new CopilotEnvConfig());
    expect(resolved).not.toBe(busy);
  });
});

// The reserve flag decides whether a profile's candidate is recorded: a peek that recorded would pin
// a port the start never used; a reservation that did not would lose the profile's stable port.
test("resolveStartPort: reserve=false peeks at a profile's candidate, reserve=true records it", async () => {
  tmpHome();
  // A one-port range keeps the candidate equal to the recorded reservation. The port must be free:
  // the scan clamps to the range, so a busy sole port throws (after reserve=true has already
  // persisted the candidate, so the throw leaves that record behind).
  const free = await freePort();
  // 4141 always seeds the scan's used set, so a pick colliding with it would exhaust the range.
  expect(free).not.toBe(4141);
  new CopilotEnvConfig().set({ "daemon.min-port": free, "daemon.max-port": free });
  for (const reserve of [false, true]) {
    const resolved = await resolveStartPort(
      undefined,
      false,
      WORK,
      reserve,
      new CopilotEnvConfig(),
    );
    expect({
      reserve,
      resolved,
      recorded: CopilotEnvRunState.forProfile(WORK).read().port,
    }).toEqual({
      reserve,
      resolved: free,
      recorded: reserve ? free : undefined,
    });
  }
});
