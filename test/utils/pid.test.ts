import { pidAlive, pidLiveness } from "../../src/utils/pid.ts";
import { expect, test } from "../helpers/testing.ts";

test.skipIf(process.platform === "win32")(
  "pidLiveness: a denied signal (EPERM) is an EXISTING pid -- alive",
  () => {
    // pid 1 always exists on POSIX. As an unprivileged user the null signal is refused
    // with EPERM (the pid exists, this token can't signal it); as root (the docker
    // suite) it is simply delivered. Alive either way, never dead.
    expect(pidLiveness(1)).toBe("alive");
    expect(pidAlive(1)).toBe(true);
  },
);
