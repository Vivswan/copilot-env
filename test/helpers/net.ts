// A real listening loopback socket, so a port probe meets a real listener and a busy-port case
// is a port something really holds.
import { createServer, type Server } from "node:net";
import getPort from "get-port";

/** The listener answers a probe's connect and nothing more. Each accepted socket is destroyed as
 *  it arrives: the probe reads "listening" from the TCP handshake, which completes before anything
 *  the server does to the connection, and a server-side socket left to the peer's end has crashed
 *  Bun 1.4.2 on Windows in that end's teardown (a segfault draining a nextTick after the listener
 *  had closed). */
export function listenEphemeral(host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
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

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A loopback port the OS just handed out and this process released again (get-port's probe). */
export function freePort(): Promise<number> {
  return getPort({ host: "127.0.0.1" });
}
