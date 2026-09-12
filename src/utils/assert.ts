/** Pass the narrowed value in the `default` arm; a new union member then fails typecheck at each
 *  call site. */
export function assertNever(value: never): never {
  throw new Error(`unreachable: unhandled case ${JSON.stringify(value)}`);
}
