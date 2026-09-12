// The proxy arm's `directIntegrationId?: never` makes a proxy write with a baked integration id
// unrepresentable; excess-property checking covers object literals only, so the never field is
// what catches a widened object. Drop the field and the widened case's ts-expect-error below
// becomes an unused directive (TS2578): the guard fails closed at typecheck time.

import type { ManagedWrite } from "../src/agents/configure.ts";
import { expect, test } from "./helpers/testing.ts";

test("a proxy ManagedWrite cannot carry a direct integration id", () => {
  // Literal path: the discriminant selects the proxy arm and the id is rejected there.
  // @ts-expect-error -- a proxy write never carries directIntegrationId
  const literal: ManagedWrite = { mode: "proxy", directIntegrationId: "x" };
  void literal;

  // Widened path: excess-property checking does not apply to a non-literal assignment, so
  // ONLY the never field rejects this one.
  const widened: { mode: "proxy"; directIntegrationId: string } = {
    mode: "proxy",
    directIntegrationId: "x",
  };
  // @ts-expect-error -- string is not assignable to the proxy arm's never field
  const fromWidened: ManagedWrite = widened;
  void fromWidened;

  // Control: the direct arm carries the id fine, so the directives above pin the proxy arm
  // specifically, not a wider breakage of the union.
  const direct: ManagedWrite = { mode: "direct", directIntegrationId: "x" };
  expect(direct.mode).toBe("direct");
});
