// Fake copilot-api gateway for CI / local lifecycle testing.
//
// Spawned by `server.ts` in place of the real gateway when COPILOT_API_ENTRY
// points here. It binds the requested port, answers the admin endpoints that
// `start` calls (so model-alias sync succeeds with an empty catalog), prints
// the exact "Listening on:" marker that `server.ts` waits for in the daemon
// log, and stays alive until killed -- exercising start -> wait-for-listen ->
// stop without GitHub Copilot auth. Invoked as: bun fake-gateway.mjs start --port N
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
