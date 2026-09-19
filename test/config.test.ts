import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync as realRename,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CopilotApiConfig } from "../src/copilot_api/config.ts";
import { renameWithRetry } from "../src/utils/fs_disk.ts";
import { afterEach, expect, tempDir, test } from "./helpers/testing.ts";

let dir = "";

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

test("save sorts keys recursively (nested objects and array elements alike), keeps array order, writes a trailing newline with mode 0600, and round-trips", () => {
  // Each row is a document shape; `before` pairs are raw-text needles whose order pins the key sort
  // (or, for the array row, that the first element still precedes the second).
  const rows: { name: string; doc: Record<string, unknown>; before: [string, string][] }[] = [
    {
      name: "nested object",
      doc: { zebra: 1, alpha: { y: 2, x: 1 } },
      before: [['"alpha"', '"zebra"'], ['"x"', '"y"']],
    },
    {
      name: "array elements",
      doc: {
        items: [
          { zulu: 1, alpha: 2 },
          { delta: 3, bravo: 4 },
        ],
      },
      before: [['"zulu": 1', '"delta": 3'], ['"alpha"', '"zulu"'], ['"bravo"', '"delta"']],
    },
  ];
  for (const row of rows) {
    dir = tempDir("copilot-config-");
    const path = join(dir, "config.json");
    const cfg = new CopilotApiConfig(path);
    cfg.save(row.doc);

    const raw = readFileSync(path, "utf8");
    for (const [first, second] of row.before) {
      expect(raw.indexOf(first), `${row.name}: ${first} < ${second}`).toBeLessThan(
        raw.indexOf(second),
      );
    }
    expect(raw.endsWith("\n"), row.name).toBe(true);
    // chmod 0600 is best-effort and a no-op on Windows.
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777, row.name).toBe(0o600);
    }
    expect(cfg.load(), row.name).toEqual(row.doc);
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

test("load returns {} for a missing, empty, or whitespace-only file", () => {
  dir = tempDir("copilot-config-");
  const path = join(dir, "config.json");
  const cfg = new CopilotApiConfig(path);
  const rows: { name: string; content: string | null }[] = [
    { name: "missing", content: null },
    { name: "empty", content: "" },
    { name: "whitespace", content: "  \n\t \n" },
  ];
  for (const row of rows) {
    if (row.content !== null) writeFileSync(path, row.content);
    expect(cfg.load(), row.name).toEqual({});
  }
});

interface Auth {
  adminApiKey: string;
  apiKeys: string[];
}

test("ensureApiKey and ensureAdminApiKey each generate a 64-hex key once, stable across calls, distinct from each other, landing under auth", () => {
  dir = tempDir("copilot-config-");
  const cfg = new CopilotApiConfig(join(dir, "config.json"));
  // Admin first: its write lands on an auth object with no apiKeys yet.
  const keys: { name: string; ensure: () => string; landed: (auth: Auth) => string }[] = [
    { name: "admin", ensure: () => cfg.ensureAdminApiKey(), landed: (auth) => auth.adminApiKey },
    { name: "api", ensure: () => cfg.ensureApiKey(), landed: (auth) => auth.apiKeys[0] as string },
  ];
  const minted: string[] = [];
  for (const key of keys) {
    const first = key.ensure();
    expect(first, key.name).toMatch(/^[0-9a-f]{64}$/);
    expect(key.ensure(), key.name).toBe(first);
    expect(key.landed(cfg.load().auth as Auth), key.name).toBe(first);
    minted.push(first);
  }
  expect(new Set(minted).size).toBe(keys.length);
  // Neither generation clobbered the other's key.
  expect(keys.map((key) => key.landed(cfg.load().auth as Auth))).toEqual(minted);
});

test("save leaves no *.tmp.* sibling behind after a successful write", () => {
  dir = tempDir("copilot-config-");
  const path = join(dir, "config.json");
  const cfg = new CopilotApiConfig(path);

  cfg.save({ alpha: 1 });
  // A second save exercises the rename-over-existing path too.
  cfg.save({ alpha: 2 });

  const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp."));
  expect(leftovers).toEqual([]);
  expect(readdirSync(dir)).toEqual(["config.json"]);
});

test("renameWithRetry retries the transient EBUSY/EPERM codes until the rename lands and surfaces any other error at once", () => {
  dir = tempDir("copilot-config-");
  // Each row: the error codes the injected rename throws on successive calls (a null code is a
  // real rename), then how many calls were made and what came of the file.
  const rows: {
    name: string;
    codes: (string | null)[];
    calls: number;
    outcome: "landed" | "thrown";
  }[] = [
    {
      name: "transient then success",
      codes: ["EBUSY", "EPERM", null],
      calls: 3,
      outcome: "landed",
    },
    // ENOENT is not transient, so it is not retried.
    { name: "non-transient", codes: ["ENOENT"], calls: 1, outcome: "thrown" },
  ];
  for (const row of rows) {
    const from = join(dir, `${row.name}-src`);
    const to = join(dir, `${row.name}-dst`);
    writeFileSync(from, "payload");
    let calls = 0;
    const rename = (f: string, t: string): void => {
      const code = row.codes[calls];
      calls += 1;
      if (code === null) {
        realRename(f, t);
        return;
      }
      const err = new Error(`rename failed: ${code}`) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    };
    let outcome: "landed" | "thrown" = "landed";
    try {
      renameWithRetry(from, to, 5, rename);
    } catch (e) {
      outcome = "thrown";
      expect((e as Error).message, row.name).toBe(`rename failed: ${row.codes.at(-1)}`);
    }
    expect({ ...row, calls, outcome }).toEqual(row);
    if (outcome === "landed") expect(readFileSync(to, "utf8"), row.name).toBe("payload");
  }
});

// update() is a read-modify-WRITE: a failed read taken as `{}` would persist the emptiness and wipe
// the daemon's api key, admin key and providers. The proxy writes config.json non-atomically, which
// is the wipe the retry loop exists for.
//
//   unreadable file (0000), writable dir  -> the read fails, the rename would succeed: the wipe
//   a directory at the path               -> the rename fails on its own, proves nothing
//   POSIX, non-root only                  -> root bypasses file modes
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "update REFUSES an unreadable store instead of WIPING it",
  () => {
    dir = tempDir("copilot-config-");
    const path = join(dir, "config.json");
    const cfg = new CopilotApiConfig(path);
    cfg.save({ auth: { apiKeys: ["secret-key"], adminApiKey: "admin-secret" } });
    const before = readFileSync(path, "utf8");
    chmodSync(path, 0o000); // readable no more; the parent dir stays writable

    try {
      let threw = "";
      try {
        cfg.update((d) => {
          d.smallModel = "gpt-6";
        });
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      // Positive assertion: a call that did NOT throw fails here instead of passing on "".
      expect(threw).toContain("refusing to overwrite it");
      // THE outcome: the secrets are still on disk, byte for byte.
      chmodSync(path, 0o600);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      chmodSync(path, 0o600);
    }
  },
);

test("update still writes normally when the store IS readable (the control)", () => {
  // Control: the refusal must not cost the ordinary path.
  dir = tempDir("copilot-config-");
  const path = join(dir, "config.json");
  const cfg = new CopilotApiConfig(path);
  cfg.save({ existing: "keep", smallModel: "gpt-5.5" });

  cfg.update((d) => {
    d.smallModel = "gpt-6";
  });

  expect(cfg.load()).toEqual({ existing: "keep", smallModel: "gpt-6" });
});

test("a genuinely absent store still reads as an empty document, not unreadable", () => {
  // The other control: absence is a PROVEN answer and must keep flowing through
  // update() as `{}` -- otherwise first-run key generation would refuse.
  dir = tempDir("copilot-config-");
  const cfg = new CopilotApiConfig(join(dir, "config.json"));
  cfg.update((d) => {
    d.created = true;
  });
  expect(cfg.load()).toEqual({ created: true });
});

// A DANGLING SYMLINK reads ENOENT through readFileSync, but the entry itself
// exists -- readTextResult's rule, shared by the store: "absent" must be PROVEN
// (entryAbsent), or update() would replace the user's link with a plain file.
// Windows symlink creation needs privileges, hence the visible skip.
test.skipIf(process.platform === "win32")(
  "a dangling symlink at the store path is unreadable, never a writable empty doc",
  () => {
    dir = tempDir("copilot-config-");
    const path = join(dir, "config.json");
    const target = join(dir, "missing-target.json");
    symlinkSync(target, path);
    const cfg = new CopilotApiConfig(path);

    expect(() => cfg.loadStrict()).toThrow("refusing to treat an unreadable store as empty");
    expect(() =>
      cfg.update((d) => {
        d.smallModel = "gpt-6";
      })
    ).toThrow("refusing to overwrite it");
    // THE outcome: the entry is still the user's symlink, pointing where it did.
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path)).toBe(target);
    // The display flatten still answers {} on the same store (warned).
    expect(cfg.load()).toEqual({});
    // Control: once the target exists, the same symlinked store reads and writes.
    writeFileSync(target, '{"kept": true}');
    expect(cfg.loadStrict()).toEqual({ kept: true });
  },
);

// loadStrict is the DECISION reader (ownership take-backs, wiring, the float pin) and throws;
// load keeps its display flatten. POSIX, non-root only: root bypasses file modes.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable store: loadStrict THROWS while load still degrades to {}",
  () => {
    dir = tempDir("copilot-config-");
    const path = join(dir, "config.json");
    const cfg = new CopilotApiConfig(path);
    cfg.save({ auth: { apiKeys: ["secret-key"] } });
    chmodSync(path, 0o000);
    try {
      let threw = "";
      try {
        cfg.loadStrict();
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      // Positive assertion, so a call that did NOT throw fails here.
      expect(threw).toContain("refusing to treat an unreadable store as empty");
      expect(threw).toContain(path);
      // The documented display flatten survives on the very same store.
      expect(cfg.load()).toEqual({});
    } finally {
      chmodSync(path, 0o600);
    }
    // Control: readable again, both readers answer the document.
    expect(cfg.loadStrict()).toEqual({ auth: { apiKeys: ["secret-key"] } });
  },
);

test("update REFUSES a store that is present but not valid JSON, preserving its bytes", () => {
  // A parse failure is refused like a read error: config.json's torn-write window can outlast
  // the retries, and for our own atomic stores the junk is outside corruption whose
  // salvageable content a reset would discard. A parsed NON-OBJECT root (an array, a scalar) is
  // the same class. The stray-token case is one whose raw V8 diagnostic quotes the source
  // (`Unexpected token 'x', "x"secret-key"" is not valid JSON`).
  const cases = [
    '{ "auth": { "apiKeys": ["secret-key"] }, half-written',
    '[42, "secret-key"]',
    "42",
    'x"secret-key"',
  ];
  for (const content of cases) {
    dir = tempDir("copilot-config-");
    const path = join(dir, "config.json");
    const cfg = new CopilotApiConfig(path);
    writeFileSync(path, content);

    let threw = "";
    try {
      cfg.update((d) => {
        d.smallModel = "gpt-6";
      });
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    expect(threw).toContain("not valid JSON");
    expect(threw).toContain("refusing to overwrite it");
    // V8 quotes the source around the fault, unescaped; the store holds keys, so none survives.
    expect(threw).not.toContain("secret-key");
    // THE outcome: the corrupt bytes (a torn write's salvageable half included)
    // are still on disk, byte for byte -- never reset to the mutation alone.
    expect(readFileSync(path, "utf8")).toBe(content);
    // Junk CONTENT is a proven fact about the file: both read-only readers degrade.
    expect(cfg.load()).toEqual({});
    expect(cfg.loadStrict()).toEqual({});
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});
