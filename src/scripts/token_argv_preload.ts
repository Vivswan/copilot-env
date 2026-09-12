// Argv is world-readable for the daemon's lifetime (/proc/<pid>/cmdline, `ps aux`, WMI
// CommandLine) while the environment is owner-only, so the token rides in env and the flag is
// spliced in-process, leaving the kernel's cmdline copy unchanged.
//   launchDaemon sets the env var -> this shim pushes `--github-token` onto process.argv -> the
//   proxy's parser and pat_passthrough_preload read it there
//
// Must load before pat_passthrough_preload, which reads the token at module load; launchDaemon
// (src/copilot_api/process.ts) orders the `--preload` flags.
//   ENV_KEY duplicates DAEMON_GH_TOKEN_ENV there    -> this preload stays import-free
//   the proxy's GITHUB_TOKEN_PATH file is unwritten -> one credential, resolved from our state
const ENV_KEY = "COPILOT_ENV_DAEMON_GH_TOKEN";
const FLAG = "--github-token";

const token = process.env[ENV_KEY];
if (token && !process.argv.includes(FLAG)) {
  process.argv.push(FLAG, token);
}
// Scrubbed either way so a child the daemon spawns never inherits it.
delete process.env[ENV_KEY];

// Module marker: without it tsc treats the top-level consts as globals shared with the other
// preloads.
export {};
