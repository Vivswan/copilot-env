// Fake copilot-api proxy for CI / local lifecycle testing.
//
// Spawned by the daemon launcher (copilot_api/process.ts) in place of the real
// proxy when COPILOT_API_ENTRY points here. It binds the requested port,
// answers the admin endpoints that `start` calls (so model-alias sync succeeds
// with an empty catalog), prints the exact "Listening on:" marker that `start`
// waits for in the daemon log, and stays alive until killed -- exercising
// start -> wait-for-listen -> stop without GitHub Copilot auth. Invoked as:
// bun copilot-api-fake.mjs start --port N
//
// The filename MUST contain "copilot-api": isCopilotApiPid (process.ts) matches
// the daemon's command line against /copilot-api.*\bstart\b/, so `stop` only
// recognizes (and signals) this process when its launch path includes that
// substring. Do not rename it to something without "copilot-api".
import { createServer } from "node:http";

const portIdx = process.argv.indexOf("--port");
const port = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : 4141;

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  if (path === "/models" || path === "/v1/models") {
    json(res, 200, { data: [] }); // empty catalog -> no aliases to sync
  } else if (path === "/admin/config/model-mappings") {
    json(res, 200, { modelMappings: {} }); // GET (read) and POST (write) both OK
  } else {
    json(res, 200, {});
  }
});

server.listen(port, "127.0.0.1", () => {
  // server.ts detects readiness by grepping the daemon log for this substring.
  console.log(`Listening on: http://127.0.0.1:${port}`);
});

// Exit cleanly when `copilot-api stop` sends SIGTERM.
process.on("SIGTERM", () => process.exit(0));
