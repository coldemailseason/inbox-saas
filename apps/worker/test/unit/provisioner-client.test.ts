import { describe, expect, it, vi } from "vitest";

import type { TenantValidationRequest } from "@inbox-saas/provisioner-contract";

import { HttpTenantValidationProvisioner } from "../../src/provisioner-client.js";
import {
  inboxNonceHeader,
  inboxSignatureHeader,
  inboxTimestampHeader,
  signProvisionerRequest,
} from "../../src/provisioner-request-auth.js";

const request: TenantValidationRequest = {
  contractVersion: "v1",
  jobId: "job-123",
  tenantConnectionId: "connection-456",
  credentials: {
    email: "user@example.com",
    password: "correct-horse-battery-staple",
  },
};

const createProvisioner = (fetch: typeof globalThis.fetch) =>
  new HttpTenantValidationProvisioner({
    baseUrl: "https://provisioner.internal/ignored/",
    serviceSecret: Buffer.alloc(32, 7),
    transportEncryptionKey: Buffer.alloc(32, 8),
    fetch,
    clock: () => new Date("2025-01-01T00:00:00.000Z"),
    nonce: () => "test-nonce",
  });

describe("HttpTenantValidationProvisioner", () => {
  it("posts a signed encrypted envelope and returns a validated result", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          contractVersion: "v1",
          status: "success",
          microsoftTenantId: "microsoft-tenant-789",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(createProvisioner(fetch).validateTenant(request)).resolves.toEqual({
      contractVersion: "v1",
      status: "success",
      microsoftTenantId: "microsoft-tenant-789",
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [, options] = fetch.mock.calls[0] ?? [];
    const body = options?.body;
    expect(typeof body).toBe("string");
    expect(body).not.toContain(request.credentials.email);
    expect(body).not.toContain(request.credentials.password);
    expect(body).not.toContain(request.jobId);
    expect(JSON.parse(body as string)).toEqual({
      iv: expect.any(String),
      ciphertext: expect.any(String),
      authTag: expect.any(String),
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://provisioner.internal/internal/v1/tenant-validations",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [inboxTimestampHeader]: "1735689600",
          [inboxNonceHeader]: "test-nonce",
          [inboxSignatureHeader]: signProvisionerRequest(
            Buffer.alloc(32, 7),
            "1735689600",
            "test-nonce",
            body as string,
          ),
        },
        body: body as string,
        signal: expect.any(AbortSignal),
      },
    );
    expect(timeout).toHaveBeenCalledWith(270_000);
  });

  it("rejects non-success responses without exposing their body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: "sensitive service response" }), { status: 503 }),
      );

    await expect(createProvisioner(fetch).validateTenant(request)).rejects.toThrow(
      "Tenant validation provisioner returned HTTP 503",
    );
  });

  it("rejects malformed JSON responses", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("not json", { status: 200 }));

    await expect(createProvisioner(fetch).validateTenant(request)).rejects.toThrow(
      "Tenant validation provisioner returned invalid JSON",
    );
  });

  it("rejects schema-invalid responses without exposing their body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "success", microsoftTenantId: "" }), { status: 200 }),
      );

    await expect(createProvisioner(fetch).validateTenant(request)).rejects.toThrow(
      "Tenant validation provisioner returned an invalid result",
    );
  });

  it("rejects failed fetches without propagating transport details", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("network unavailable"));

    await expect(createProvisioner(fetch).validateTenant(request)).rejects.toThrow(
      "Tenant validation provisioner request failed",
    );
  });
});
