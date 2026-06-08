#!/usr/bin/env bun
// Release-bundled installer handoff: bootstraps deps and invokes setup shell wiring.
//
// Direct run:
//   bun src/install/installer.ts install [--no-shell-integration] [--all-hosts]
//
// Arguments:
//   install                   Required command; keeps accidental direct runs explicit.
//   --no-shell-integration    Bootstrap deps only; skip `agent setup shell`.
//   --all-hosts               Windows only; pass through to `agent setup shell --all-hosts`.
//
// install.sh / install.ps1 run this from the extracted release so installer
// behavior comes from the selected release, not from main.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface InstallOptions {
  noShellIntegration: boolean;
  allHosts: boolean;
}

export function parseInstallArgs(args: string[]): InstallOptions {
  const command = args[0];
  if (command !== "install") {
    throw new Error(
      "usage: bun src/install/installer.ts install [--no-shell-integration] [--all-hosts]",
    );
  }

  const options: InstallOptions = { noShellIntegration: false, allHosts: false };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--no-shell-integration") {
      options.noShellIntegration = true;
    } else if (arg === "--all-hosts") {
      options.allHosts = true;
    } else {
      throw new Error(`unknown argument '${arg}'`);
    }
  }
  return options;
}

export function shellSetupArgs(options: InstallOptions): string[] | null {
  if (options.noShellIntegration) return null;
  const args = ["setup", "shell"];
  if (options.allHosts) args.push("--all-hosts");
  return args;
}

function projectRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

function runAgent(root: string, args: string[]): void {
  const agent =
    process.platform === "win32" ? join(root, "bin", "agent.ps1") : join(root, "bin", "agent");
  const command =
    process.platform === "win32"
      ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", agent, ...args]
      : [agent, ...args];
  const result = spawnSync(command[0] ?? "", command.slice(1), {
    cwd: root,
    stdio: args[0] === "env" ? ["ignore", "ignore", "inherit"] : "inherit",
    env: { ...process.env, HUSKY: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`agent ${args.join(" ")} failed`);
}

export function runInstall(options: InstallOptions): void {
  const root = projectRoot();
  const agent =
    process.platform === "win32" ? join(root, "bin", "agent.ps1") : join(root, "bin", "agent");
  if (!existsSync(agent)) throw new Error(`could not find agent launcher at ${agent}`);

  console.log("Bootstrapping copilot-env dependencies ...");
  runAgent(root, ["env"]);

  const setupArgs = shellSetupArgs(options);
  if (setupArgs === null) {
    console.log("Skipping shell wiring (--no-shell-integration).");
  } else {
    runAgent(root, setupArgs);
  }

  console.log("");
  if (options.noShellIntegration) {
    console.log("Done. Shell wiring was skipped; run 'agent setup shell' to enable it.");
  } else {
    console.log(
      process.platform === "win32"
        ? "Done. Restart PowerShell to load the integration."
        : "Done. Restart your shell to load the integration.",
    );
  }
  console.log("Then use 'agent start' to launch the gateway.");
  console.log("Optional: run 'agent setup clis --launchers' for CLIs and cl/co/cx shortcuts.");
}

if (import.meta.main) {
  try {
    runInstall(parseInstallArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
