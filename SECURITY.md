# Security Policy

## Supported Versions

Only the latest published release is supported. `copilot-env` ships versioned
GitHub Releases (tagged `vX.Y.Z` via release-please) and is not published to a
package registry. Security fixes land in the next release. Install from the
latest GitHub Release asset (`install.sh` / `install.ps1`), or run
`agent update` to upgrade to the newest release tag.

## Reporting a Vulnerability

Please report security issues privately through GitHub's private vulnerability
reporting. Go to the repository's **Security** tab and choose
**"Report a vulnerability"**, or use this link:

https://github.com/Vivswan/copilot-env/security/advisories/new

Do **not** open public issues, pull requests, or discussions for security
reports.

We aim to acknowledge new reports on a best-effort basis, typically within a
few days. As a small, volunteer-maintained project we cannot commit to a fixed
response or remediation timeline.

## Security Model / Scope

`copilot-env` is a local CLI that manages a `@jeffreycao/copilot-api` proxy on
your own machine. Its security posture:

- **Secrets stay local.** The GitHub Copilot credential lives in
  `~/.local/share/copilot-api/.copilot-env-state.json` (the `gh-cli` provider
  stores no token and defers to the machine's `gh` login), and the proxy API
  key in `~/.local/share/copilot-api/config.json`. Agent configs never store a
  copy; they resolve the credential at fetch time via `agent auth --get`.
  These files are written with `0600` (owner read/write only) permissions on
  POSIX systems; on Windows they rely on the profile directory's ACLs. No
  secret is ever committed to this repository.
- **Local proxy, key-gated.** Clients are wired to `127.0.0.1` and inference
  and admin endpoints require the generated API keys (a few informational
  endpoints, such as the root page and usage viewer, are unauthenticated).
  The daemon itself currently binds all interfaces (the underlying server's
  default), so on an untrusted network rely on a host firewall in addition to
  the API key.
- **Supply-chain posture.** The proxy dependency floats but by default only
  adopts releases that have been public for at least 7 days (the
  `minimumReleaseAge` fallback in `bunfig.toml`; override the window with the
  `release-cooldown` config key or `COPILOT_API_MIN_RELEASE_AGE`, or bypass it
  by pinning via the `proxy-version` config key or `COPILOT_API_VERSION`),
  clamped to the version floor/ceiling in `copilot-env.config` — and `agent
  start` refuses to launch a proxy below that floor regardless of how it was
  installed. Every other dependency is pinned via the committed `bun.lock`
  for reproducible installs.
