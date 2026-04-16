import { describe, it } from "vitest";

// Full mTLS wire-level assertion requires cert generation harness. The unit-
// level resolution behavior is covered in identity-injection.test.ts (Task 1);
// the full round-trip is exercised by the Task 14 end-to-end loopback. This
// file is a scaffold placeholder so future cert-harness work has a home.
describe.skip("X-Sender-Agent on remote outbound", () => {
  it.todo("sets X-Sender-Agent header on outbound mTLS POST");
});
