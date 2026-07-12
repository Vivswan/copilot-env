// Preloaded FIRST into the copilot-api daemon -- before pat_passthrough_preload and before
// the proxy parses its argv. It reads the GitHub token from the COPILOT_ENV_DAEMON_GH_TOKEN
// environment variable and splices it into process.argv as `--github-token <token>`.
//
// Why: the proxy only accepts the token via the `--github-token` flag (or its own token
// file, which we deliberately never write). Passing it on the launch argv puts the secret in
// the WORLD-READABLE process command line -- /proc/<pid>/cmdline, `ps aux`, WMI CommandLine --
// where any other local user can read it for the daemon's whole lifetime. The environment is
// owner-only instead (/proc/<pid>/environ is 0600; `ps e` shows only your own processes), so
// we hand the token through env and reconstruct the flag in-process. Mutating process.argv at
// runtime does NOT change the kernel's cmdline copy, so the token never appears there -- yet
// the proxy's arg parser and the PAT passthrough shim, which both read process.argv, still
// receive it unchanged.
//
// This is a RUNTIME shim: it touches none of copilot-api's files, so it never pins the
// floated proxy version. It must load before pat_passthrough_preload (which reads the token
// from argv at module-load time); launchDaemon orders the `--preload` flags accordingly.
const ENV_KEY = "COPILOT_ENV_DAEMON_GH_TOKEN";
const FLAG = "--github-token";

const token = process.env[ENV_KEY];
if (token && !process.argv.includes(FLAG)) {
  process.argv.push(FLAG, token);
}
// Scrub it either way so the secret can't leak to a child process the daemon might spawn,
// and isn't left readable in this process's environment longer than necessary.
delete process.env[ENV_KEY];

// `export {}` marks this file an ES module so its top-level `token`/`ENV_KEY`/`FLAG` are
// module-scoped, not globals that would collide with the other preload scripts under tsc.
export {};
