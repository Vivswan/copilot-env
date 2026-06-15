// Shared exhaustiveness assertion.

/**
 * Compile-time proof that a switch / if-chain over a union is total: pass the value
 * in the `default` (or final `else`) arm, where TypeScript has narrowed it to `never`
 * if every case was handled. Adding a new union member then becomes a typecheck error
 * at each call site instead of a silent fall-through. Reaching it at runtime means an
 * upstream invariant was violated (e.g. an unvalidated value escaped its boundary).
 */
export function assertNever(value: never): never {
  throw new Error(`unreachable: unhandled case ${JSON.stringify(value)}`);
}
