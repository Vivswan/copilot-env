// A real listening loopback socket, so a port probe meets a real listener and a busy-port case
// is a port something really holds.
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { deadline } from "@std/async";
import getPort from "get-port";

const ACCEPTED = new WeakMap<Server, Set<Promise<unknown>>>();

const CLOSE_GRACE_MS = 1_000;

/** The listener answers a probe's connect and nothing more: the probe reads "listening" from the
 *  TCP handshake, which completes before anything the server does to the connection, so each
 *  accepted socket is destroyed as it arrives. Bun 1.4.2 on Windows has segfaulted three times
 *  in these listeners' teardown (a nextTick drained after a server-side socket's end once the
 *  listener had closed; a libuv poll request completing for a closed handle), so the accepted
 *  sockets' close events are kept for closeServer to wait on. */
export function listenEphemeral(host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const accepted = new Set<Promise<unknown>>();
    const server = createServer((socket: Socket) => {
      const closed: Promise<void> = once(socket, "close").then(() => {
        accepted.delete(closed);
      });
      accepted.add(closed);
      socket.destroy();
    });
    ACCEPTED.set(server, accepted);
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected an AddressInfo from a TCP server"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

/** Less overlap between a listener's teardown and whatever follows it: work still queued for the
 *  listener (an accept, a peer's destroy, the close events) gets its turns before the caller goes
 *  on. Both waits, the accepted sockets' closes and the listener's own, are bounded by the grace,
 *  so neither a socket nor a listener whose close never fires can hold a test. */
export async function closeServer(server: Server): Promise<void> {
  await nextTurn();
  await withinGrace(Promise.all(ACCEPTED.get(server) ?? []));
  const closed = once(server, "close");
  server.close();
  await withinGrace(closed);
  await nextTurn();
}

async function withinGrace(settled: Promise<unknown>): Promise<void> {
  try {
    await deadline(settled, CLOSE_GRACE_MS);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "TimeoutError")) throw error;
  }
}

/** A loopback port the OS just handed out and this process released again (get-port's probe). */
export function freePort(): Promise<number> {
  return getPort({ host: "127.0.0.1" });
}
