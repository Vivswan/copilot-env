# Patches

Hand-edits to `node_modules/` are persisted here by [patch-package](https://github.com/ds300/patch-package). Files in this directory are auto-applied during `npm install` (via the `postinstall` script in `package.json`).

## Workflow

1. Edit files under `node_modules/@jeffreycao/copilot-api/dist/`.
2. Generate a patch:
   ```
   npx patch-package @jeffreycao/copilot-api
   ```
   This writes `patches/@jeffreycao+copilot-api+<version>.patch`.
3. Commit both the patch file and the `package.json` change pinning the version.
4. New checkouts get the patch automatically on `npm install`.

## Notes

- **The gateway floats to `"latest"` (≥7-day cooldown), so patches are normally incompatible.** A patch is keyed to one exact version and won't apply once the float moves on. To patch, first pin `@jeffreycao/copilot-api` to an exact version in `package.json` (freezing the float), generate the patch, and commit both together. Restore `"latest"` (and drop the patch) to resume floating.
- `patch-package` is kept non-fatal (it warns rather than failing the install), so a stale patch won't break startup — but don't rely on it applying.
- When bumping a pinned version, regenerate the patch by re-editing and re-running `npx patch-package`.
