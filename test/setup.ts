// Global bun-test preload (wired via bunfig.toml [test].preload).
//
// Hard-disable the Codex desktop-app patch during tests. syncCodexAppImageGeneration
// (src/codex/app_patch.ts) resolves the REAL installed Codex app via osascript /
// PowerShell — it ignores the per-test CODEX_HOME isolation — so without this a
// `runCodex({ direct })` unit test, or an `init --proxy` smoke subprocess, would
// modify /Applications/Codex.app during the suite. Subprocess tests inherit this
// through isolatedEnv()'s `...process.env` spread.
process.env.COPILOT_API_NO_APP_PATCH = "1";
