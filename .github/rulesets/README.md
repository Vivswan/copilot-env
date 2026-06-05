# Branch protection ruleset for `main`

`main.json` is a GitHub **repository ruleset** (config-as-code). GitHub does not
auto-apply files in this directory — import it once, then it's live.

## What it enforces (on `main`)

- **Restrict deletions** (`deletion`)
- **Block force pushes** (`non_fast_forward`)
- **Require status checks to pass** (`required_status_checks`): the CI matrix
  (`ubuntu-latest`, `macos-latest`, `windows-latest`) + `actionlint`
- **Require code scanning results** (`code_scanning`): CodeQL, blocking on
  high-or-higher security alerts and on errors
- **Bypass**: the **Repository admin** role (`RepositoryRole` id `5`,
  `bypass_mode: always`) — so admins can still push directly to `main`

## Import / update

Create it:

```bash
gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/Vivswan/copilot-env/rulesets \
  --input .github/rulesets/main.json
```

Update an existing one (find its id via `gh api /repos/Vivswan/copilot-env/rulesets`):

```bash
gh api --method PUT \
  -H "Accept: application/vnd.github+json" \
  /repos/Vivswan/copilot-env/rulesets/<RULESET_ID> \
  --input .github/rulesets/main.json
```

You can also import via the UI: **Settings → Rules → Rulesets → New ruleset → Import a ruleset**.

## Enable in the UI (not in this JSON)

These are newer ruleset rules whose config-as-code schema isn't pinned here yet —
add them to the imported ruleset via **Settings → Rules → Rulesets → main**:

- **Require code quality results**
- **Automatically request Copilot code review** → enable *Review new pushes* and
  *Review draft pull requests*

## Related repo settings (live in `.github/settings.yml`)

- **Allow auto-merge** → `repository.allow_auto_merge: true`
- Squash-only merges, wiki/projects off, etc.
