// A catch binding reaches a printer, or a list a summary prints later, only as the first argument
// of caught(e, frame), whose result may be passed on whole; it leaves the clause only as itself or
// as a call's first argument (`throw rethrown(e, frame)`).
//
// Any text made of either (`String(e)`, a template, a helper, a local filled from it) turns a
// thrown scannable into a string, and the printer's wrap splits its command row at a narrow width.
//
// Syntactic and per clause: the latest binding decides a name's kind, a conditional reassignment
// counts as the binding, and a value passed through an intermediate object is not followed. One
// pass per file, pinned by test/utils/caught_lint.test.ts, which fails on any finding under src/.
import { type Expression, visitorKeys } from "oxc-parser";
import { parseModule, visit } from "../helpers/syntax.ts";

/** The consola and logger methods and the notify seam, called on any receiver. */
const PRINTER_METHODS = new Set([
  "warn",
  "error",
  "info",
  "log",
  "success",
  "debug",
  "start",
  "box",
  "ready",
  "fatal",
  "trace",
  "verbose",
  "notify",
]);
/** A free function whose name says it prints: the message and table printers, and any `printX`
 *  or `logX` helper. */
const PRINTER_FUNCTION = /^(print|log)[A-Z]/;
const STREAMS = new Set(["stdout", "stderr"]);
/** The list methods a collector fills, called on any receiver. */
const COLLECTOR_METHODS = new Set(["push", "unshift"]);
/** The functions a catch binding is handed as its parameter: `function (e)` and `(e) =>`. */
const FUNCTIONS = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);
/** The loops that bind each element of what they iterate. */
const ELEMENT_LOOPS = new Set(["ForOfStatement", "ForInStatement"]);
/** The message helpers that take the caught error first and keep its parts. */
const CONVERTERS = new Set(["caught", "rethrown"]);
/** The message makers whose parts may hold a converter's result, called or constructed. */
const COMPOSERS = new Set(["scannable", "ScannableError", "ScannableMessage"]);
/** A member whose non-computed key is a name, not a read. */
const KEYED = new Set(["Property", "MethodDefinition", "PropertyDefinition", "AccessorProperty"]);
/** The TypeScript nodes wrapping a value: their `expression` is read, their type is not. */
const TYPED_EXPRESSIONS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
]);
const THROWN_AS_TEXT = "throw rebuilds the caught error as text: throw it, or rethrown(e, frame)";

type Node = Record<string, unknown> & { type: string; start: number; end: number };

interface PrinterFinding {
  /** Offset of the printer call in the source. */
  start: number;
  message: string;
}

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === "object" && typeof (value as Node).type === "string";
}

function children(node: Node): Node[] {
  return (visitorKeys[node.type] ?? []).flatMap((key) => {
    const value = node[key];
    if (Array.isArray(value)) return value.filter(isNode);
    return isNode(value) ? [value] : [];
  });
}

function identifierName(node: Node): string | null {
  return node.type === "Identifier" ? (node.name as string) : null;
}

/** The children of `node` a variable read can sit in: not a member's non-computed key, a declared
 *  or function name, a label, an import or export name, a JSX attribute name, or a type. */
function readPositions(node: Node): Node[] {
  if (node.type === "MemberExpression") {
    // `e.message` reads `e`; a property named like the binding (`x.e`) is a name.
    const object = node.object as Node;
    return node.computed === true ? [object, node.property as Node] : [object];
  }
  if (KEYED.has(node.type)) {
    const value = isNode(node.value) ? [node.value] : [];
    return node.computed === true ? [node.key as Node, ...value] : value;
  }
  if (
    FUNCTIONS.has(node.type) ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression"
  ) {
    return children(node).filter((child) => child !== node.id);
  }
  if (node.type === "VariableDeclarator") return isNode(node.init) ? [node.init] : [];
  if (node.type === "LabeledStatement") return [node.body as Node];
  if (node.type === "JSXAttribute") return isNode(node.value) ? [node.value] : [];
  if (
    node.type === "BreakStatement" ||
    node.type === "ContinueStatement" ||
    node.type === "MetaProperty" ||
    node.type.startsWith("Import") ||
    node.type.startsWith("Export")
  ) {
    return [];
  }
  if (node.type.startsWith("TS")) {
    return TYPED_EXPRESSIONS.has(node.type) ? [node.expression as Node] : [];
  }
  return children(node);
}

/** `node` without the type-only wrappers around it (`x as T`, `x!`, `x satisfies T`): the value
 *  itself at runtime. */
function unwrapped(node: Node): Node {
  return TYPED_EXPRESSIONS.has(node.type) ? unwrapped(node.expression as Node) : node;
}

/** The printer a call reaches, or null: a method from PRINTER_METHODS on any receiver, a free
 *  function named like a printer, `console.<any>`, or `process.stdout|stderr.write`. */
function printerOf(callee: Expression): string | null {
  if (callee.type === "Identifier") return PRINTER_FUNCTION.test(callee.name) ? callee.name : null;
  if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return null;
  const method = callee.property.name;
  const receiver = callee.object;
  if (receiver.type === "Identifier" && receiver.name === "console") return `console.${method}`;
  if (
    method === "write" &&
    receiver.type === "MemberExpression" &&
    receiver.object.type === "Identifier" &&
    receiver.object.name === "process" &&
    receiver.property.type === "Identifier" &&
    STREAMS.has(receiver.property.name)
  ) {
    return `process.${receiver.property.name}.write`;
  }
  return PRINTER_METHODS.has(method) ? method : null;
}

/** What a sink does with an argument: a printer prints it, a list's push collects it for the
 *  printer of a later summary. */
interface Sink {
  name: string;
  verb: "prints" | "collects";
}

function sinkOf(callee: Expression): Sink | null {
  const printer = printerOf(callee);
  if (printer !== null) return { name: printer, verb: "prints" };
  if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return null;
  const method = callee.property.name;
  return COLLECTOR_METHODS.has(method) ? { name: method, verb: "collects" } : null;
}

/** What a name is bound to: the caught error itself or a name bound to it; a caught() result or a
 *  name bound to one, which a sink may take whole; or text made of either, the string again (a
 *  destructured property of either is text). */
type Kind = "error" | "structured" | "text";

const KINDS: Kind[] = ["error", "structured", "text"];

/** One lexical scope: each name declared in it with its kind, null for a value made of no tracked
 *  name (the declaration still shadows an outer one). `hoist` is where a `var` lands, the nearest
 *  function or clause scope; null when this scope is one. */
interface Scope {
  bindings: Map<string, Kind | null>;
  parent: Scope | null;
  hoist: Scope | null;
}

function scopeOf(parent: Scope, declared: [string, Kind | null][] = [], hoisting = false): Scope {
  return { bindings: new Map(declared), parent, hoist: hoisting ? null : (parent.hoist ?? parent) };
}

/** The scope `name` resolves to, innermost first, or null for a name declared in none. */
function owner(scope: Scope, name: string): Scope | null {
  let current: Scope | null = scope;
  while (current !== null && !current.bindings.has(name)) current = current.parent;
  return current;
}

function isNamed(node: Node, scope: Scope, kind: Kind): boolean {
  const name = identifierName(unwrapped(node));
  return name !== null && owner(scope, name)?.bindings.get(name) === kind;
}

/** `callee(err, ...)` with the caught error first: how caught(e, frame) and rethrown(e, frame)
 *  take it. */
function takesErrorFirst(node: Node, scope: Scope): boolean {
  if (node.type !== "CallExpression") return false;
  const [first] = node.arguments as Node[];
  return first !== undefined && isNamed(first, scope, "error");
}

/** Whether `node` reads a tracked name anywhere, each resolved where it stands. */
function mentions(node: Node, scope: Scope): boolean {
  if (node.type === "Identifier") return KINDS.some((kind) => isNamed(node, scope, kind));
  const inner = FUNCTIONS.has(node.type) ? functionScope(node, scope) : scope;
  return readPositions(node).some((child) => mentions(child, inner));
}

/** A value that keeps the parts: a converter handed the caught error (`caught(e, frame)`,
 *  `rethrown(e, frame)`), or a composer whose parts mention a tracked name only through kept
 *  values (`scannable({ evidence: [caught(e, frame)] })`, `new ScannableError(...)`). Its parts
 *  are expressions, so this and `reaches` recurse into each other. */
function isStructuredValue(wrapped: Node, scope: Scope): boolean {
  const node = unwrapped(wrapped);
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return false;
  const callee = identifierName(node.callee as Node);
  if (callee !== null && CONVERTERS.has(callee)) return takesErrorFirst(node, scope);
  if (callee === null || !COMPOSERS.has(callee)) return false;
  const parts = node.arguments as Node[];
  return (
    parts.some((part) => mentions(part, scope)) && !parts.some((part) => reachesAny(part, scope))
  );
}

/** Whether `node` is allowed at a sink as it is: a structured value, or a name bound to one. */
function keepsParts(node: Node, scope: Scope): boolean {
  return isStructuredValue(node, scope) || isNamed(node, scope, "structured");
}

/** `evidence: [...]` in a parts literal: the one list that carries a Message whole. */
function isEvidenceList(node: Node): boolean {
  return (
    node.type === "Property" &&
    identifierName(node.key as Node) === "evidence" &&
    (node.value as Node).type === "ArrayExpression"
  );
}

/** Whether `node` reads a name of `kind`, each resolved where it stands. A structured value is
 *  read as one, not as the names inside it; an evidence list keeps a value that keeps the parts. */
function reaches(node: Node, scope: Scope, kind: Kind): boolean {
  if (node.type === "Identifier") return isNamed(node, scope, kind);
  if (isStructuredValue(node, scope)) return kind === "structured";
  if (isEvidenceList(node)) {
    return ((node.value as Node).elements as (Node | null)[]).some(
      (element) => element !== null && !keepsParts(element, scope) && reaches(element, scope, kind),
    );
  }
  const inner = FUNCTIONS.has(node.type) ? functionScope(node, scope) : scope;
  return readPositions(node).some((child) => reaches(child, inner, kind));
}

function reachesAny(node: Node, scope: Scope): boolean {
  return KINDS.some((kind) => reaches(node, scope, kind));
}

/** Whether a thrown `node` leaves the clause whole: the error itself, a structured value or a name
 *  bound to one, or a call or construction handed the error as an argument of its own
 *  (`new Wrapped(path, e)`). */
function leavesWhole(wrapped: Node, scope: Scope): boolean {
  const node = unwrapped(wrapped);
  if (isNamed(node, scope, "error") || keepsParts(node, scope)) return true;
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return false;
  return (node.arguments as Node[]).some((argument) => isNamed(argument, scope, "error"));
}

/** The kind of a value made of `source`, or null for one made of no tracked name. */
function kindOfValue(source: Node, scope: Scope): Kind | null {
  if (isNamed(source, scope, "error")) return "error";
  if (keepsParts(source, scope)) return "structured";
  if (reachesAny(source, scope)) return "text";
  return null;
}

/** What a binding pattern declares from a value of `kind`: a name takes it whole; a destructured
 *  property, element, or rest is text made of it; a name whose default is made of a tracked name is
 *  text. `x`, `{ a, b: c, ...rest }`, `[d]`, `x = fallback`, and the same nested; a property's
 *  key binds nothing. A default is an expression, so this and `reaches` recurse into each other. */
function patternBindings(pattern: Node, kind: Kind | null, scope: Scope): [string, Kind | null][] {
  const part = kind === null ? null : "text";
  switch (pattern.type) {
    case "Identifier":
      return [[pattern.name as string, kind]];
    case "ObjectPattern":
      return (pattern.properties as Node[]).flatMap((property) =>
        patternBindings(
          (property.type === "RestElement" ? property.argument : property.value) as Node,
          part,
          scope,
        ),
      );
    case "ArrayPattern":
      return (pattern.elements as (Node | null)[]).flatMap((element) =>
        element === null ? [] : patternBindings(element, part, scope),
      );
    case "AssignmentPattern": {
      const fallback = reachesAny(pattern.right as Node, scope) ? "text" : null;
      return patternBindings(pattern.left as Node, kind ?? fallback, scope);
    }
    case "RestElement":
      return patternBindings(pattern.argument as Node, part, scope);
    default:
      return [];
  }
}

/** `const pattern = value` in `scope`; a default in the pattern resolves in `from`. */
function declare(scope: Scope, pattern: Node, kind: Kind | null, from: Scope): void {
  for (const [name, bound] of patternBindings(pattern, kind, from)) scope.bindings.set(name, bound);
}

/** `pattern = value`: each name's binding takes its kind where the name resolves; a name declared
 *  in no scope (a variable from outside the clause) is bound in the clause's own. */
function assign(scope: Scope, root: Scope, pattern: Node, kind: Kind | null): void {
  for (const [name, bound] of patternBindings(pattern, kind, scope)) {
    (owner(scope, name) ?? root).bindings.set(name, bound);
  }
}

/** `fn`'s own scope: its parameters installed left to right, each untracked unless its default is
 *  made of a tracked name, resolved where the parameters before it already shadow. */
function functionScope(fn: Node, parent: Scope): Scope {
  const inner = scopeOf(parent, [], true);
  for (const param of (fn.params as Node[]) ?? []) declare(inner, param, null, inner);
  return inner;
}

/** A clause's own scope, its `binding` (a name or a pattern) bound to the caught error. */
function clauseScope(binding: Node): Scope {
  const root: Scope = { bindings: new Map(), parent: null, hoist: null };
  declare(root, binding, "error", root);
  return root;
}

function findingFor(argument: Node, scope: Scope, sink: Sink): string | null {
  if (keepsParts(argument, scope)) return null;
  if (reaches(argument, scope, "error") || reaches(argument, scope, "text")) {
    return `${sink.name}() ${sink.verb} the caught error as text: report it with caught(e, frame)`;
  }
  if (reaches(argument, scope, "structured")) {
    return `${sink.name}() ${sink.verb} text made from a caught() result: pass the result itself`;
  }
  return null;
}

/** The functions and classes declared directly in `block`, bound untracked before its statements:
 *  a declaration's name shadows from the top of its block. */
function hoistDeclared(block: Node, scope: Scope): void {
  for (const statement of block.body as Node[]) {
    if (statement.type !== "FunctionDeclaration" && statement.type !== "ClassDeclaration") continue;
    const name = identifierName(statement.id as Node);
    if (name !== null) scope.bindings.set(name, null);
  }
}

/** Walks a clause body under `root`, the clause's scope holding its binding: every block, loop,
 *  function, and nested clause opens a scope of its own, and every sink or throw earns its
 *  finding. */
function scanClause(body: Node, root: Scope, findings: PrinterFinding[]): void {
  const walk = (node: Node, scope: Scope): void => {
    if (FUNCTIONS.has(node.type)) {
      const inner = functionScope(node, scope);
      for (const child of children(node)) walk(child, inner);
      return;
    }
    if (node.type === "CatchClause" && isNode(node.param)) {
      // The nested clause's own binding is scanned by scanCaughtPrinters.
      walk(node.body as Node, scopeOf(scope, patternBindings(node.param, null, scope)));
      return;
    }
    if (ELEMENT_LOOPS.has(node.type)) {
      walkElementLoop(node, scope);
      return;
    }
    if (node.type === "BlockStatement" || node.type === "ForStatement") {
      const inner = scopeOf(scope);
      if (node.type === "BlockStatement") hoistDeclared(node, inner);
      for (const child of children(node)) walk(child, inner);
      return;
    }
    if (node.type === "VariableDeclaration") {
      const target = node.kind === "var" ? (scope.hoist ?? scope) : scope;
      for (const declarator of node.declarations as Node[]) {
        const init = isNode(declarator.init) ? declarator.init : null;
        if (init !== null) walk(init, scope);
        const kind = init === null ? null : kindOfValue(init, scope);
        declare(target, declarator.id as Node, kind, scope);
      }
      return;
    }
    if (node.type === "AssignmentExpression") {
      // `x op= y` is `x = x op y`: the whole assignment is the source.
      const source = node.operator === "=" ? (node.right as Node) : node;
      assign(scope, root, node.left as Node, kindOfValue(source, scope));
    }
    if (node.type === "ThrowStatement") {
      const thrown = node.argument as Node;
      if (!leavesWhole(thrown, scope) && reachesAny(thrown, scope)) {
        findings.push({ start: node.start, message: THROWN_AS_TEXT });
      }
    }
    if (node.type === "CallExpression") {
      const sink = sinkOf(node.callee as Expression);
      if (sink !== null) {
        for (const argument of node.arguments as Node[]) {
          const message = findingFor(argument, scope, sink);
          if (message !== null) findings.push({ start: node.start, message });
        }
      }
    }
    for (const child of children(node)) walk(child, scope);
  };

  /** `for (const x of value)`: each element is a value made of `value`, declared or assigned. */
  const walkElementLoop = (node: Node, scope: Scope): void => {
    const inner = scopeOf(scope);
    const left = node.left as Node;
    const right = node.right as Node;
    const kind = kindOfValue(right, scope);
    if (left.type === "VariableDeclaration") {
      const target = left.kind === "var" ? (scope.hoist ?? scope) : inner;
      for (const declarator of left.declarations as Node[]) {
        declare(target, declarator.id as Node, kind, scope);
      }
    } else {
      assign(inner, root, left, kind);
    }
    walk(right, scope);
    walk(node.body as Node, inner);
  };

  walk(body, root);
}

/** Every printer call, list push, and throw under `source` that a catch binding reaches other
 *  than through caught(e, frame), that result's name, or a rethrow taking the error whole: a
 *  `catch (e)` clause's body, or a `.catch((e) => ...)` callback's; a destructured binding is the
 *  error's text from the start. */
export function scanCaughtPrinters(path: string, source: string): PrinterFinding[] {
  const findings: PrinterFinding[] = [];
  visit(parseModule(path, source).program, {
    CatchClause(clause) {
      const node = clause as unknown as Node;
      if (isNode(node.param)) scanClause(node.body as Node, clauseScope(node.param), findings);
    },
    CallExpression(call) {
      const node = call as unknown as Node;
      const callee = node.callee as Node;
      const [handler] = node.arguments as Node[];
      const [binding] = (handler !== undefined ? (handler.params as Node[]) : undefined) ?? [];
      if (
        callee.type === "MemberExpression" &&
        (callee.property as Node).type === "Identifier" &&
        (callee.property as Node).name === "catch" &&
        handler !== undefined &&
        FUNCTIONS.has(handler.type) &&
        binding !== undefined
      ) {
        scanClause(handler.body as Node, clauseScope(binding), findings);
      }
    },
  });
  return findings;
}
