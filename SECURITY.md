# Security policy

## Supported versions

Only the latest release is supported.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/vivswan/copilot-env/security/advisories/new) ("Report a vulnerability"). If that page is unavailable (GitHub offers no advisories on private personal repositories), contact [@Vivswan](https://github.com/vivswan) directly instead. A useful report includes:

- what an attacker can do (impact), and where trust is broken,
- reproduction steps or a proof of concept,
- the affected version or commit.

Expect an acknowledgement within a few days, and a fix in the next release once the report is confirmed. Please allow reasonable time for that fix before any public disclosure.

Never include real credentials in a report; redact everything that looks like a key.

<!-- Repository-specific security documentation (scope, threat model, review
     expectations for security-relevant changes) goes below this line. It survives template updates via three-way merge. -->
<!-- repo-platform:local-section -->

## Security model / scope

`copilot-env` is a local CLI that manages a `@jeffreycao/copilot-api` proxy on your own machine. Its security posture:

- **Secrets stay local.** The GitHub Copilot credential lives in `~/.local/share/copilot-api/.copilot-env-state.json` (the `gh-cli` provider stores no token and defers to the machine's `gh` login), and the proxy API key in `~/.local/share/copilot-api/config.json`. Agent configs never store a copy; they resolve the credential at fetch time via `agent auth --get`. These files are written with `0600` (owner read/write only) permissions on POSIX systems; on Windows they rely on the profile directory's ACLs. No secret is ever committed to this repository.
- **Local proxy, key-gated.** Clients are wired to `127.0.0.1` and inference and admin endpoints require the generated API keys (a few informational endpoints, such as the root page and usage viewer, are unauthenticated). The daemon itself currently binds all interfaces (the underlying server's default), so on an untrusted network rely on a host firewall in addition to the API key.
- **Supply-chain posture.** The proxy dependency floats but by default only adopts releases that have been public for at least 7 days (the built-in cooldown default; override the window with the `release-cooldown` config key or `COPILOT_API_MIN_RELEASE_AGE`, or bypass it by pinning via the `proxy-version` config key or `COPILOT_API_VERSION`), clamped to the version floor/ceiling in `copilot-env.config` - and `agent start` refuses to launch a proxy below that floor regardless of how it was installed. Every other dependency is pinned via the committed `deno.lock` for reproducible installs.
- **Releases, not a registry.** `copilot-env` ships as versioned GitHub Releases (tagged `vX.Y.Z` via release-please) and is not published to any package registry. To pick up fixes, install from the latest release's `install.sh` / `install.ps1` asset, or run `agent update` to move to the newest release tag.
