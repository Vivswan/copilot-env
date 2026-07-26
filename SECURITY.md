# Security policy

## Supported versions

Only the latest published release is supported. `copilot-env` ships versioned GitHub
Releases (tagged `vX.Y.Z` via release-please) and is not published to a
package registry. Security fixes land in the next release. Install from the
latest GitHub Release asset (`install.sh` / `install.ps1`), or run
`agent update` to upgrade to the newest release tag.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/vivswan/copilot-env/security/advisories/new)
("Report a vulnerability"). A useful report includes:

- what an attacker can do (impact), and where trust is broken,
- reproduction steps or a proof of concept,
- the affected version or commit.

Expect an acknowledgement within a few days, and a fix in the next release
once the report is confirmed. Please allow reasonable time for that fix
before any public disclosure.

Never include real credentials in a report; redact everything that looks like
a key.

<!-- Repository-specific security documentation (scope, threat model, review
     expectations for security-relevant changes) goes below this line. It
     survives template updates via three-way merge. -->
