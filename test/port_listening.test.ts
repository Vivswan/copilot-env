import { expect, test } from "bun:test";
import { createServer } from "node:net";

import { portListening } from "../src/commands/start.ts";

/** Bind a throwaway TCP server to an ephemeral loopback port and return it. */
function listen(host: string): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

test("portListening: true while a socket is bound, false once it closes", async () => {
  const server = await listen("127.0.0.1");
  try {
    expect(await portListening(server.port)).toBe(true);
  } finally {
    await server.close();
  }
  expect(await portListening(server.port)).toBe(false);
});

test("portListening: detects an IPv6-loopback-only listener too", async () => {
  // The probe tries 127.0.0.1 then ::1, mirroring fetch's localhost resolution, so a daemon
  // bound only to IPv6 loopback is still found. Skip if the host has no IPv6 loopback.
  let server: { port: number; close: () => Promise<void> };
  try {
    server = await listen("::1");
  } catch {
    return; // no IPv6 loopback on this machine -- nothing to assert
  }
  try {
    expect(await portListening(server.port)).toBe(true);
  } finally {
    await server.close();
  }
});

test("portListening: false for a port nobody is listening on", async () => {
  // Grab an ephemeral port then release it, so it is (almost certainly) free.
  const server = await listen("127.0.0.1");
  const { port } = server;
  await server.close();
  expect(await portListening(port, 500)).toBe(false);
});
