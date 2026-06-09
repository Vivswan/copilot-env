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

`copilot-env` is a local CLI that manages a `@jeffreycao/copilot-api` gateway on
your own machine. Its security posture:

- **Secrets stay local.** The gateway API key is stored in
  `~/.local/share/copilot-api/config.json`, and the Codex key in
  `~/.codex/.env`. Both files are written with `0600` (owner read/write only)
  permissions. No secret is ever committed to this repository.
- **Localhost-only binding.** The gateway listens on `localhost` and is not
  exposed to the network.
- **Supply-chain posture.** The gateway dependency floats but only adopts
  releases that have been public for at least 7 days (a cooldown configured in
  `bunfig.toml`). Every other dependency is pinned via the committed
  `bun.lock` for reproducible installs.
