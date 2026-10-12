import { ok } from "node:assert";

/** Pass the narrowed value in the `default` arm; a new union member then fails typecheck at each
 *  call site. */
export function assertNever(value: never): never {
  throw new Error(`unreachable: unhandled case ${JSON.stringify(value)}`);
}

/** Pins a presence the types cannot carry; `invariant` names what makes the value present, so
 *  a throw says what broke. An adapter over assert.ok because callers need the narrowed value
 *  back, which ok() does not return. */
export function must<T>(value: T | null | undefined, invariant: string): T {
  ok(value !== null && value !== undefined, `invariant broken: ${invariant}`);
  return value;
}
