import { describe, expect, it } from "vitest";

import {
  inboxNonceHeader,
  inboxSignatureHeader,
  inboxTimestampHeader,
  signProvisionerRequest,
} from "../../src/provisioner-request-auth.js";

describe("signProvisionerRequest", () => {
  it("signs the timestamp, nonce, and SHA-256 hash of the exact UTF-8 body", () => {
    expect(
      signProvisionerRequest(
        Buffer.alloc(32, 7),
        "1735689600",
        "test-nonce",
        '{"message":"h\u00e9llo"}',
      ),
    ).toBe("a57bb58b7d0a75472ec8055aae2395f973689a48b1592c7c442999e9f95c5862");
  });

  it("rejects signing keys that are not 32 bytes", () => {
    expect(() => signProvisionerRequest(Buffer.alloc(31), "1", "nonce", "{}")).toThrow(
      "must be 32 bytes",
    );
  });

  it("exports the private request authentication header names", () => {
    expect(inboxTimestampHeader).toBe("X-Inbox-Timestamp");
    expect(inboxNonceHeader).toBe("X-Inbox-Nonce");
    expect(inboxSignatureHeader).toBe("X-Inbox-Signature");
  });
});
