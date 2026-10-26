// What would drift silently: a catch site that prints the caught error as text, or pushes it onto
// a list a summary prints later, turns a thrown scannable into a string, and the printer splits
// its command row at a narrow width (the `agent settings --import` and `agent profile work sync
// --claude` specimens). The scanner is swept over src/, its teeth pinned against one doctored
// source per way around it.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PROJECT_ROOT } from "../../src/utils/root.ts";
import { expect, test } from "../helpers/testing.ts";
import { tsFilesUnder } from "../helpers/tree.ts";
import { scanCaughtPrinters } from "../lint/caught_printer.ts";

const SPECIMEN = "src/commands/example.ts";

function inCatch(body: string): string {
  return `try { run(); } catch (e) { ${body} }`;
}

test("no catch binding under src/ reaches a printer or a list other than as caught(e, frame), or leaves its clause other than whole", () => {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(join(PROJECT_ROOT, "src"))) {
    const path = relative(PROJECT_ROOT, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    for (const finding of scanCaughtPrinters(path, source)) {
      const line = source.slice(0, finding.start).split("\n").length;
      offenders.push(`${path}:${line} ${finding.message}`);
    }
  }
  expect(offenders).toEqual([]);
});

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: the rows are source text under test

/** One doctored source per way a catch binding reaches a printer, a list, or a rebuilt throw, with its count. */
const ROWS: Array<[string, number]> = [
  // Every way around a syntactic errMessage() match.
  [inCatch("logger.warn(`${e}`);"), 1],
  [inCatch("logger.warn(String(e));"), 1],
  [inCatch("logger.warn(e.message);"), 1],
  [inCatch("logger.warn(describe(e));"), 1],
  [inCatch("const text = describe(e); logger.warn(text);"), 1],
  [inCatch("let text = ''; text = errMessage(e); logger.warn(text);"), 1],
  [inCatch("process.stderr.write(errMessage(e));"), 1],
  [inCatch("process.stdout.write(`${e.message}\\n`);"), 1],
  [inCatch("console.log(e);"), 1],
  [inCatch("logger.warn(`could not sync: ${errMessage(e)}`);"), 1],
  [inCatch("consola.error(errMessage(e));"), 1],
  [inCatch("createStderrLogger().warn(`preflight: ${errMessage(e)}`);"), 1],
  [inCatch("printWrappedToStderr(`refused (${errMessage(e)}).`);"), 1],
  [inCatch("printKeyValue('state', errMessage(e));"), 1],
  [inCatch("printTable([[errMessage(e), 'x']]);"), 1],
  [inCatch("deps.notify(`the start would refuse: ${errMessage(e)}`);"), 1],
  [inCatch("items.forEach(() => logger.warn(errMessage(e)));"), 1],
  // A promise's catch callback is a catch too.
  ["run().catch((err: unknown) => { consola.error(errMessage(err)); });", 1],
  // A list a collector fills is a summary's text later: the three wiring collectors.
  [inCatch("failures.push(`${agent.label}: ${errMessage(e)}`);"), 1],
  [inCatch("outcome.failures.push(`profile '${name}': ${errMessage(e)}`);"), 1],
  [inCatch("const text = errMessage(e); failures.unshift(text);"), 1],
  // The sanctioned ways out: reported by caught(), rethrown whole or by rethrown(), handed to a
  // helper or a wrapping error whole, kept as evidence; and the uses that are not prints.
  [inCatch("logger.warn(caught(e, (message) => `could not sync: ${message}`));"), 0],
  ["run().catch((e: unknown) => { consola.error(caught(e, (message) => message)); });", 0],
  [inCatch("failures.push(caught(e, (message) => `${agent.label}: ${message}`));"), 0],
  [inCatch("throw e;"), 0],
  [inCatch("throw rethrown(e, (message) => `could not read ${file}: ${message}`);"), 0],
  [inCatch("throw withRollbackHint(e, backupPath);"), 0],
  [inCatch("throw new RenameRefusedError(path, e);"), 0],
  [
    inCatch(
      "throw new ScannableError({ headline: 'could not restore the link.', evidence: [link, caught(e, (message) => message)] });",
    ),
    0,
  ],
  // A rethrow that rebuilds the error from its text: the sites rethrown() replaced.
  [inCatch("throw new Error(`could not read ${file}: ${errMessage(e)}`);"), 1],
  [inCatch("throw new Error(verificationFailedMessage(tag, errMessage(e)));"), 1],
  [inCatch("const text = String(e); throw new Error(text);"), 1],
  [inCatch("throw new Error(`failed: ${errMessage(e)}`, { cause: e });"), 1],
  [
    inCatch(
      "throw new ScannableError({ headline: 'could not restore the link.', evidence: [link, errMessage(e)] });",
    ),
    1,
  ],
  [
    inCatch("const reported = caught(e, (message) => message); throw new Error(String(reported));"),
    1,
  ],
  [
    `function look() { ${inCatch("return { kind: 'skipped', reason: `no scratch home (${errMessage(e)})` };")} }`,
    0,
  ],
  [inCatch("state.set({ lastResult: `error: ${errMessage(e)}` });"), 0],
  // A caught() result's name passes whole, to a printer or a list, through a second name too;
  // any text made of it is the string again.
  [inCatch("const reported = caught(e, (message) => message); logger.warn(reported);"), 0],
  [
    inCatch(
      "const reported = caught(e, (message) => message); const again = reported; failures.push(again);",
    ),
    0,
  ],
  [inCatch("const reported = caught(e, (message) => message); logger.warn(String(reported));"), 1],
  [inCatch("const reported = caught(e, (message) => message); logger.warn(`${reported}`);"), 1],
  [inCatch("const reported = caught(e, (message) => message); logger.warn(reported.message);"), 1],
  [
    inCatch("const reported = caught(e, (message) => message); logger.warn(errMessage(reported));"),
    1,
  ],
  [
    inCatch("const reported = caught(e, (message) => message); logger.warn(describe(reported));"),
    1,
  ],
  [
    inCatch(
      "const reported = caught(e, (message) => message); const text = String(reported); logger.warn(text);",
    ),
    1,
  ],
  [
    inCatch(
      "const reported = caught(e, (message) => message); failures.push(reported.toString());",
    ),
    1,
  ],
  // The latest binding decides: `x op= y` is `x = x op y`, caught() over text made of a result
  // cannot restore its parts, a literal frees the name, and the error's own alias is the error.
  [
    inCatch(
      "let reported = caught(e, (message) => message); reported += ''; logger.warn(reported);",
    ),
    1,
  ],
  [
    inCatch(
      "const reported = caught(e, (message) => message); const text = String(reported); logger.warn(caught(text, (message) => message));",
    ),
    1,
  ],
  [
    inCatch(
      "let reported = caught(e, (message) => message); reported = 'recovered'; logger.warn(reported.toUpperCase());",
    ),
    0,
  ],
  [inCatch("const err = e; logger.warn(caught(err, (message) => message));"), 0],
  [inCatch("const err = e; logger.warn(err);"), 1],
  // A nested block's own declaration leaves the outer name as it was.
  [
    inCatch(
      "const reported = caught(e, (message) => message); { const reported = 'clean'; } logger.warn(String(reported));",
    ),
    1,
  ],
  // Names are lexical: a block-local declaration shadows for the block alone, an assignment
  // updates the binding it resolves to, and a loop binds each element of what it iterates.
  [
    inCatch(
      "const text = errMessage(e); { const text = caught(e, (message) => message); } logger.warn(text);",
    ),
    1,
  ],
  [
    inCatch(
      "const text = caught(e, (message) => message); { const text = errMessage(e); } logger.warn(text);",
    ),
    0,
  ],
  [
    inCatch(
      "const reported = caught(e, (message) => message); { let reported = 'clean'; reported = 'still'; } logger.warn(String(reported));",
    ),
    1,
  ],
  [
    inCatch(
      "const reported = caught(e, (message) => message); { const reported = 'clean'; logger.warn(String(reported)); }",
    ),
    0,
  ],
  [
    inCatch(
      "const reported = caught(e, (message) => message); for (const text of [String(reported)]) logger.warn(text);",
    ),
    1,
  ],
  // A `var` is the clause's or the function's, not the block's.
  [inCatch("{ var text = String(e); } logger.warn(text);"), 1],
  // A list holds a caught() result whole only as a parts literal's evidence; operated on, it is
  // text again.
  [inCatch("logger.warn([caught(e, (message) => message)].join('\\n'));"), 1],
  [inCatch("logger.warn(String([caught(e, (message) => message)]));"), 1],
  // A destructured property of the error, of a caught() result, or of text made of either is
  // text, renamed or nested; one of another value is nothing.
  [inCatch("if (e instanceof Error) { const { message } = e; logger.warn(message); }"), 1],
  [inCatch("const { message: detail } = e; logger.warn(detail);"), 1],
  [inCatch("const { response: { status } } = e; logger.warn(String(status));"), 1],
  [inCatch("const [first] = String(e).split(':'); logger.warn(first);"), 1],
  [
    inCatch(
      "const reported = caught(e, (message) => message); const { parts } = reported; logger.warn(String(parts));",
    ),
    1,
  ],
  [inCatch("const { message } = someOtherValue; logger.warn(message);"), 0],
  // A default made of a tracked name is text; a destructured clause or handler binding is the
  // error's text from the start; a `var` loop binding is the clause's.
  [inCatch("const { text = String(e) } = {}; logger.warn(text);"), 1],
  [inCatch("const [text = String(e)] = []; throw new Error(text);"), 1],
  ["try { run(); } catch ({ message }) { logger.warn(message); }", 1],
  ["run().catch(({ message }) => { logger.warn(message); });", 1],
  [
    inCatch(
      "var message = ''; if (e instanceof Error) { for (var { message } of [e]) {} logger.warn(message); }",
    ),
    1,
  ],
  // A parameter's default or type names nothing: the outer name stays reachable in the body.
  // A default resolves where the parameters before it already shadow.
  [inCatch("const show = (e: string, text = e) => logger.warn(text); show('clean');"), 0],
  [inCatch("const show = (text = e) => logger.warn(text); show();"), 1],
  [
    inCatch(
      "const reported = caught(e, (message) => message); [1].forEach((other = reported) => logger.warn(String(reported)));",
    ),
    1,
  ],
  [
    inCatch(
      "const reported = caught(e, (message) => message); [1].forEach((other: typeof reported) => logger.warn(String(reported)));",
    ),
    1,
  ],
  // A name is read only where a value is read: not as a fixed key, a member's name, or a type;
  // a computed key and a shorthand property are reads.
  [inCatch("logger.warn({ e: 'clean' });"), 0],
  [inCatch("logger.warn({ e() { return 'clean'; } });"), 0],
  [inCatch("logger.warn(box.e);"), 0],
  [inCatch("logger.warn(value as typeof e);"), 0],
  [inCatch("logger.warn({ [e]: 'clean' });"), 1],
  [inCatch("logger.warn({ e });"), 1],
  // A message composed from kept values is structured: passed whole it is fine, its text is
  // a finding; one composed from the error's text is that text.
  [
    inCatch(
      "const summary = scannable({ headline: 'failed', evidence: [caught(e, (message) => message)] }); logger.warn(String(summary));",
    ),
    1,
  ],
  [
    inCatch(
      "const summary = scannable({ headline: 'failed', evidence: [caught(e, (message) => message)] }); logger.warn(summary);",
    ),
    0,
  ],
  [
    inCatch(
      "logger.warn(String(new ScannableError({ headline: 'failed', evidence: [caught(e, (message) => message)] })));",
    ),
    1,
  ],
  [inCatch("logger.warn(scannable({ headline: String(e) }));"), 1],
  [inCatch("const err = rethrown(e, (message) => message); throw err;"), 0],
  // A function or class declared in a block shadows its name from the block's top; a function
  // named otherwise still closes over the binding.
  [inCatch("{ function e() { return 'clean'; } logger.warn(e()); }"), 0],
  [inCatch("{ logger.warn(e()); function e() { return 'clean'; } }"), 0],
  [inCatch("{ class e {} logger.warn(String(new e())); }"), 0],
  [inCatch("function show() { logger.warn(String(e)); } show();"), 1],
  // A type-only wrapper (`as`, `satisfies`, `!`) leaves the value what it is at runtime.
  [
    inCatch("const reported = caught(e, (message) => message); logger.warn(reported as Message);"),
    0,
  ],
  [
    inCatch(
      "const reported = caught(e, (message) => message); logger.warn(reported satisfies Message);",
    ),
    0,
  ],
  [
    inCatch(
      "const reported = caught(e, (message) => message); const m = reported as Message; logger.warn(m);",
    ),
    0,
  ],
  [inCatch("failures.push(caught(e, (message) => message) as Message);"), 0],
  [
    inCatch(
      "const reported = caught(e, (message) => message); logger.warn(String(reported) as string);",
    ),
    1,
  ],
  // A type-only wrapper around a throw leaves it what it is too.
  [inCatch("throw withRollbackHint(e, backupPath) as Error;"), 0],
  [inCatch("throw new RenameRefusedError(path, e) as Error;"), 0],
  [inCatch("throw rethrown(e, (message) => message) as Error;"), 0],
  [inCatch("throw new Error(String(e)) as Error;"), 1],
  // A nested parameter of the same name shadows the binding; a property named like it is not it.
  [inCatch("items.forEach((e) => logger.info(e));"), 0],
  [inCatch("logger.warn(options.e);"), 0],
  [inCatch("logger.warn('could not sync; see the log');"), 0],
  // A nested clause of the same name is one scan, not two; one of another name keeps the outer
  // binding reachable.
  [
    inCatch(
      inCatch("const reported = caught(e, (message) => message); logger.warn(String(reported));"),
    ),
    1,
  ],
  [inCatch("try { run(); } catch (err) { logger.warn(String(e)); }"), 1],
];

// biome-ignore-end lint/suspicious/noTemplateCurlyInString: the rows are source text under test

test(
  "the scanner finds each way a catch binding reaches a printer, a list, or a rebuilt throw as " +
    "text, once, resolving names lexically, and passes caught() on the error or its alias, its " +
    "result passed whole, a rethrow whole, a stored string, a freed name, and a shadowing parameter",
  () => {
    for (const [source, count] of ROWS) {
      expect(scanCaughtPrinters(SPECIMEN, source).length, source).toBe(count);
    }
  },
);
