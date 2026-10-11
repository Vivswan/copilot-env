// The Deno globals the daemon-side modules use. In this phase the CLI runs on Bun while the proxy
// daemon still runs on the Deno sidecar (src/copilot_api/sidecar.ts), loading the
// src/scripts/*_preload.ts shims and what they import; those files keep their Deno calls and
// typecheck against this declaration under `types: ["bun"]`. Only the members they use are
// declared, so a new Deno call in src/ is a type error until it is added here on purpose. This
// file goes when the daemon leaves Deno.
declare namespace Deno {
  /** daemon_shutdown.ts: the drained server's exit. */
  function exit(code?: number): never;

  /** daemon_shutdown.ts: the SIGTERM handler is POSIX-only. */
  const build: { readonly os: string };

  /** daemon_shutdown.ts: the drain on `agent stop`'s SIGTERM. */
  function addSignalListener(signal: string, handler: () => void): void;

  /** client_headers_preload.ts: names the proxy entry in its refusal. */
  const mainModule: string;

  namespace errors {
    /** node_compat_preload.ts: the permission refusal read as node's `false`. */
    class NotCapable extends Error {}
  }
}
