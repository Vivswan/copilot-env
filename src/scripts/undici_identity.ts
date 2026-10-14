// What the proxy's `import ... from "undici"` resolves to once client_headers_preload.ts has
// re-pointed the specifier: bun's own undici, with the one class that opens the /responses
// handshake subclassed so the resolved client identity rides on it. Loaded only through that
// rewrite, so it never runs without the preload's identity.
import { WebSocket as BunWebSocket } from "undici";
import { type HandshakeInit, handshakeInit } from "./client_headers_preload.ts";

export * from "undici";

class WebSocket extends BunWebSocket {
  constructor(url: string | URL, init?: HandshakeInit) {
    // Typed as the undici package declares the constructor; at runtime the class is bun's, which
    // takes the `headers` the proxy passes.
    super(url, handshakeInit(url, init) as ConstructorParameters<typeof BunWebSocket>[1]);
  }
}

export { WebSocket };
