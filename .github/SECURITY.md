# Security policy

## Supported versions

Only the latest release is supported.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through [GitHub Security Advisories](https://github.com/Vivswan/copilot-env/security/advisories/new) ("Report a vulnerability"). If that page is unavailable, contact [@Vivswan](https://github.com/Vivswan) directly.

A useful report includes:

- what an attacker can do, and where trust breaks
- reproduction steps or a proof of concept
- the affected version or commit

Expect an acknowledgement within a few days, and a fix in the next release once confirmed. Please allow time for that fix before any public disclosure. Never include real credentials in a report; redact anything that looks like a key.

## Security model

`copilot-env` is a local CLI that manages a `@jeffreycao/copilot-api` proxy on your own machine.

**Secrets stay local**

| What                      | Where                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GitHub Copilot credential | `~/.local/share/copilot-env/credentials.json` (the `gh-cli` provider stores no token; it defers to the machine's `gh` login) |
| Proxy API key             | `~/.local/share/copilot-env/profiles/<name>/config.json` (`default` for the default profile)                                 |
| Agent configs             | no copy; they resolve the credential at fetch time via `agent auth --get`                                                    |

Both files are written `0600` on POSIX; on Windows they rely on the profile directory's ACLs. No secret is committed to this repository.

**Local proxy, key-gated**

- Clients are wired to `127.0.0.1`; inference and admin endpoints require the generated API keys.
- A few informational endpoints (the root page, the usage viewer) are unauthenticated.
- The daemon binds all interfaces (the underlying server's default): on an untrusted network, add a host firewall.

**Supply chain**

- The proxy floats, but by default adopts only releases public for at least 7 days (`release-cooldown` key or `COPILOT_API_MIN_RELEASE_AGE` changes the window).
- A pin (`proxy-version` key or `COPILOT_API_VERSION`) bypasses the cooldown and installs that version.
- The float stays inside the version floor and ceiling in `copilot-env.config`; `agent start` refuses a proxy below the floor however it was installed.
- Every other dependency is pinned by the committed `deno.lock`.

**Releases, not a registry**

- Ships as versioned GitHub Releases (`vX.Y.Z` via release-please); nothing is published to a package registry.
- To pick up fixes: the latest release's `install.sh` / `install.ps1`, or `agent update`.
