/** Pass the narrowed value in the `default` arm; a new union member then fails typecheck at each
 *  call site. */
export function assertNever(value: never): never {
  throw new Error(`unreachable: unhandled case ${JSON.stringify(value)}`);
}

/** `actual` is a parsed document's field, so a non-array is a plain false, never a throw. */
export function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((v, i) => actual[i] === v);
}
