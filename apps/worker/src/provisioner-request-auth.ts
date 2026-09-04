import { createHash, createHmac } from "node:crypto";

export const inboxTimestampHeader = "X-Inbox-Timestamp";
export const inboxNonceHeader = "X-Inbox-Nonce";
export const inboxSignatureHeader = "X-Inbox-Signature";

export function signProvisionerRequest(
  secret: Buffer,
  timestamp: string,
  nonce: string,
  rawBody: string,
): string {
  if (secret.byteLength !== 32) {
    throw new Error("Provisioner service secret must be 32 bytes");
  }

  if (!timestamp) {
    throw new Error("Provisioner request timestamp is required");
  }

  if (!nonce) {
    throw new Error("Provisioner request nonce is required");
  }

  if (!rawBody) {
    throw new Error("Provisioner request body is required");
  }

  const bodyHash = createHash("sha256").update(rawBody, "utf8").digest("hex");
  const canonicalRequest = `${timestamp}\n${nonce}\n${bodyHash}`;

  return createHmac("sha256", secret).update(canonicalRequest, "utf8").digest("hex");
}
