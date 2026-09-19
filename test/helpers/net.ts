// A real listening loopback socket, so a port probe meets a real listener and a busy-port case
// is a port something really holds.
import { createServer, type Server } from "node:net";

export function listenEphemeral(host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
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

/** A port the OS just handed out and this process released again. */
export async function freePort(): Promise<number> {
  const { server, port } = await listenEphemeral();
  await closeServer(server);
  return port;
}
