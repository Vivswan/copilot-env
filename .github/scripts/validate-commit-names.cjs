const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

const allowedTypes = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
];

const conventionalSubject = new RegExp(
  `^(${allowedTypes.join("|")})(\\([A-Za-z0-9._/-]+\\))?!?: .+`,
);
const zeroSha = /^0{40}$/;

function subject(message) {
  return String(message ?? "").split(/\r?\n/, 1)[0].trim();
}

function isMergeSubject(value) {
  return /^Merge (pull request|branch|remote-tracking branch)\b/.test(value);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

// True when `rev` resolves to a commit present in this checkout. A force-push
// orphans the old tip (and a shallow clone may never fetch it), so `before`
// can name a commit that no longer exists -- `git rev-list before..after`
// would then fail fatally. We use this to fall back to the push payload.
function revExists(rev) {
  try {
    // stdio "ignore" keeps git's "fatal: Not a valid object name" off the log
    // -- a missing `before` is an expected, handled case, not an error.
    execFileSync("git", ["cat-file", "-e", `${rev}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shasInRange(range) {
  const output = git(["rev-list", "--reverse", range]);
  return output ? output.split(/\r?\n/) : [];
}

function commitSubject(sha) {
  return subject(git(["show", "-s", "--format=%s", sha]));
}

function eventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }
  return JSON.parse(readFileSync(eventPath, "utf8"));
}

function listCommits() {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const payload = eventPayload();

  if (eventName === "pull_request") {
    const base = payload.pull_request?.base?.sha;
    const head = payload.pull_request?.head?.sha;
    if (!base || !head) {
      throw new Error("pull_request event is missing base/head SHAs.");
    }
    return shasInRange(`${base}..${head}`).map((sha) => ({
      sha,
      subject: commitSubject(sha),
    }));
  }

  if (eventName === "push") {
    const before = payload.before;
    const after = payload.after;
    // Only diff a range when both endpoints are real and reachable here;
    // otherwise (new branch, or a force-push that orphaned `before`) validate
    // the commits GitHub listed in this push payload instead.
    if (before && after && !zeroSha.test(before) && revExists(before) && revExists(after)) {
      return shasInRange(`${before}..${after}`).map((sha) => ({
        sha,
        subject: commitSubject(sha),
      }));
    }
    return (payload.commits ?? []).map((commit) => ({
      sha: commit.id,
      subject: subject(commit.message),
    }));
  }

  return [];
}

function validateCommitNames() {
  const commits = listCommits();
  const checked = commits.filter((commit) => !isMergeSubject(commit.subject));
  const failures = checked.filter((commit) => !conventionalSubject.test(commit.subject));

  console.log(`Checked ${checked.length} non-merge commit subject(s).`);

  if (failures.length > 0) {
    const lines = failures.map((commit) => `- ${commit.sha.slice(0, 7)} ${commit.subject}`);
    console.error(
      [
        "Commit subjects must be Conventional Commits.",
        "Examples: `feat: add setup flow`, `fix: repair installer`, `feat!: simplify bootstrap`, `chore(main): release 3.0.0`.",
        "",
        ...lines,
      ].join("\n"),
    );
    process.exitCode = 1;
  }
}

validateCommitNames();
