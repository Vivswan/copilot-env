// Compile-time pins for src/agents/configure.ts's ManagedWrite union. The
// proxy arm's `directIntegrationId?: never` is what makes "proxy write with a
// baked integration id" unrepresentable. Excess-property checking only covers
// object LITERALS, so without the never field a widened (non-literal) object
// would carry a proxy+id write into every writer unflagged. Same pattern as
// test/usage.test.ts's brand guard: drop the never field and the WIDENED case's
// ts-expect-error directive below becomes an UNUSED directive, which deno check
// reports as an error (TS2578) -- the guard fails closed at typecheck time.
// (The literal case would still error without the field, via the discriminated
// union's excess-property check; the widened directive is the pin.)
//
// Deferred convention note: src/health/checks.ts's named-profile
// RE-WIRE fix hints (profileAddFix; the slot's mode is sticky on a re-add) use
// bare `agent profile --add <name>` file-wide by convention -- the explicit
// `--direct|--proxy` form appears only where no mode is recorded. If the bare
// shape is ever changed, change it file-wide, not per call site.

import type { ManagedWrite } from "../src/agents/configure.ts";
import { expect, test } from "./helpers/testing.ts";

test("a proxy ManagedWrite cannot carry a direct integration id", () => {
  // Literal path: the discriminant selects the proxy arm and the id is
  // rejected there.
  // @ts-expect-error -- a proxy write never carries directIntegrationId
  const literal: ManagedWrite = { mode: "proxy", directIntegrationId: "x" };
  void literal;

  // Widened path: excess-property checking does not apply to a non-literal
  // assignment, so ONLY the never field rejects this one -- the case the
  // field exists for.
  const widened: { mode: "proxy"; directIntegrationId: string } = {
    mode: "proxy",
    directIntegrationId: "x",
  };
  // @ts-expect-error -- string is not assignable to the proxy arm's never field
  const fromWidened: ManagedWrite = widened;
  void fromWidened;

  // Control: the direct arm carries the id fine, so the directives above pin
  // the proxy arm specifically, not some wider breakage of the union.
  const direct: ManagedWrite = { mode: "direct", directIntegrationId: "x" };
  expect(direct.mode).toBe("direct");
});
