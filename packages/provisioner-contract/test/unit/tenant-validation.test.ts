import { describe, expect, it } from "vitest";

import { tenantValidationRequestSchema, tenantValidationResultSchema } from "../../src/index.js";

describe("tenant validation contract", () => {
  it("parses a valid request and result", () => {
    expect(
      tenantValidationRequestSchema.parse({
        contractVersion: "v1",
        jobId: "job-1",
        tenantConnectionId: "tenant-connection-1",
        credentials: {
          email: "admin@example.com",
          password: "secret",
        },
      }),
    ).toEqual({
      contractVersion: "v1",
      jobId: "job-1",
      tenantConnectionId: "tenant-connection-1",
      credentials: {
        email: "admin@example.com",
        password: "secret",
      },
    });

    expect(
      tenantValidationResultSchema.parse({
        contractVersion: "v1",
        status: "success",
        microsoftTenantId: "microsoft-tenant-1",
      }),
    ).toEqual({
      contractVersion: "v1",
      status: "success",
      microsoftTenantId: "microsoft-tenant-1",
    });
  });

  it("rejects invalid tenant admin credentials", () => {
    expect(() =>
      tenantValidationRequestSchema.parse({
        contractVersion: "v1",
        jobId: "job-1",
        tenantConnectionId: "tenant-connection-1",
        credentials: {
          email: "not-an-email",
          password: "",
        },
      }),
    ).toThrow();
  });

  it("rejects credential-shaped result data", () => {
    expect(() =>
      tenantValidationResultSchema.parse({
        contractVersion: "v1",
        status: "failure",
        code: "invalid_credentials",
        retryable: false,
        credentials: {
          email: "admin@example.com",
          password: "secret",
        },
      }),
    ).toThrow();
  });

  it("rejects arbitrary failure codes", () => {
    expect(() =>
      tenantValidationResultSchema.parse({
        contractVersion: "v1",
        status: "failure",
        code: "Microsoft error: password=secret",
        retryable: false,
      }),
    ).toThrow();
  });
});
