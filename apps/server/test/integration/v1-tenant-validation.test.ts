import { createAuth } from "@inbox-saas/auth";
import {
  accessGrant,
  createDb,
  idempotencyRecord,
  job,
  organization,
  outboxEvent,
  tenantConnection,
  user,
  workspace,
} from "@inbox-saas/db";
import { createTenantCredentialCipher, issueApiKey } from "@inbox-saas/product";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.includes("test")) {
  throw new Error("TEST_DATABASE_URL must point to an isolated test database");
}

const database = createDb(testDatabaseUrl);
const auth = createAuth(database);
const app = createApp({
  database,
  authInstance: auth,
  credentialCipher: createTenantCredentialCipher({
    key: Buffer.alloc(32, 1),
    keyVersion: "test-v1",
  }),
});
const credentials = { email: "tenant-admin@example.test", password: "private-password" };
const publicJobFields = [
  "createdAt",
  "failureCode",
  "id",
  "operation",
  "retryable",
  "status",
  "updatedAt",
];

type PublicTenantValidationJob = {
  id: string;
  operation: "tenant_validation";
  status: "processing" | "completed" | "failed";
  failureCode: string | null;
  retryable: boolean | null;
  createdAt: string;
  updatedAt: string;
};

type PublicTenantConnection = {
  id: string;
  organizationId: string;
  workspaceId: string;
  state: "validating" | "active" | "validation_failed" | "detached";
  microsoftTenantId: string | null;
  createdAt: string;
  updatedAt: string;
};

type TenantValidationResponse = {
  job: PublicTenantValidationJob;
  tenantConnection: PublicTenantConnection;
};

let userId: string;
let organizationOneId: string;
let organizationTwoId: string;
let workspaceOneId: string;
let workspaceTwoId: string;
let workspaceThreeId: string;
let sessionCookie: string;
let organizationWriteToken: string;
let workspaceOneWriteToken: string;
let workspaceTwoWriteToken: string;
let crossOrganizationWriteToken: string;
let workspaceOneReadToken: string;
let workspaceTwoReadToken: string;

async function issueOrganizationToken(organizationId: string, permission: "read" | "write") {
  return (
    await issueApiKey(database, {
      creatorUserId: userId,
      expiresAt: new Date(Date.now() + 60_000),
      organizationId,
      permission,
      scope: "organization",
    })
  ).token;
}

async function issueWorkspaceToken(
  organizationId: string,
  workspaceId: string,
  permission: "read" | "write",
) {
  return (
    await issueApiKey(database, {
      creatorUserId: userId,
      expiresAt: new Date(Date.now() + 60_000),
      organizationId,
      permission,
      scope: "workspace",
      workspaceId,
    })
  ).token;
}

function requestValidation(
  workspaceId: string,
  token: string,
  idempotencyKey: string,
  body = credentials,
) {
  return app.request(`/api/v1/workspaces/${workspaceId}/tenant-connections`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ credentials: body }),
  });
}

async function readTenantValidationResponse(response: Response): Promise<TenantValidationResponse> {
  // SAFETY: The tenant-validation endpoints return the fixed public response shape modeled above.
  return (await response.json()) as TenantValidationResponse;
}

beforeEach(async () => {
  const suffix = crypto.randomUUID();
  const email = `v1-tenant-validation-${suffix}@example.test`;
  const response = await auth.handler(
    new Request("http://localhost:3001/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3001" },
      body: JSON.stringify({
        email,
        name: "V1 Tenant Validation User",
        password: "a-secure-test-password",
        initialOrganizationName: "V1 Tenant Validation Initial Organization",
      }),
    }),
  );
  const cookie = response.headers.get("set-cookie");
  if (!response.ok || !cookie) {
    throw new Error("Expected signup to create a session cookie");
  }
  sessionCookie = cookie.split(";", 1)[0] ?? "";

  const [createdUser] = await database
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  if (!createdUser) {
    throw new Error("Expected signup to create a user");
  }
  userId = createdUser.id;

  const initialGrants = await database
    .select({ organizationId: accessGrant.organizationId })
    .from(accessGrant)
    .where(eq(accessGrant.userId, userId));
  await database.delete(organization).where(
    inArray(
      organization.id,
      initialGrants.map((grant) => grant.organizationId),
    ),
  );

  const organizations = await database
    .insert(organization)
    .values([
      { name: "Tenant Validation Organization One" },
      { name: "Tenant Validation Organization Two" },
    ])
    .returning({ id: organization.id });
  const [organizationOne, organizationTwo] = organizations;
  if (!organizationOne || !organizationTwo) {
    throw new Error("Expected two organizations");
  }
  organizationOneId = organizationOne.id;
  organizationTwoId = organizationTwo.id;

  const workspaces = await database
    .insert(workspace)
    .values([
      { name: "Tenant Validation Workspace One", organizationId: organizationOneId },
      { name: "Tenant Validation Workspace Two", organizationId: organizationOneId },
      { name: "Tenant Validation Workspace Three", organizationId: organizationTwoId },
    ])
    .returning({ id: workspace.id });
  const [workspaceOne, workspaceTwo, workspaceThree] = workspaces;
  if (!workspaceOne || !workspaceTwo || !workspaceThree) {
    throw new Error("Expected three workspaces");
  }
  workspaceOneId = workspaceOne.id;
  workspaceTwoId = workspaceTwo.id;
  workspaceThreeId = workspaceThree.id;

  organizationWriteToken = await issueOrganizationToken(organizationOneId, "write");
  workspaceOneWriteToken = await issueWorkspaceToken(organizationOneId, workspaceOneId, "write");
  workspaceTwoWriteToken = await issueWorkspaceToken(organizationOneId, workspaceTwoId, "write");
  crossOrganizationWriteToken = await issueWorkspaceToken(
    organizationTwoId,
    workspaceThreeId,
    "write",
  );
  workspaceOneReadToken = await issueWorkspaceToken(organizationOneId, workspaceOneId, "read");
  workspaceTwoReadToken = await issueWorkspaceToken(organizationOneId, workspaceTwoId, "read");
});

afterEach(async () => {
  await database
    .delete(organization)
    .where(inArray(organization.id, [organizationOneId, organizationTwoId]));
  await database.delete(user).where(eq(user.id, userId));
});

describe("tenant validation v1 API", () => {
  it("rejects malformed idempotency keys and request bodies", async () => {
    const responses = await Promise.all([
      app.request(`/api/v1/workspaces/${workspaceOneId}/tenant-connections`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workspaceOneWriteToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ credentials }),
      }),
      requestValidation(workspaceOneId, workspaceOneWriteToken, " ", {
        ...credentials,
        email: "invalid",
      }),
      app.request(`/api/v1/workspaces/${workspaceOneId}/tenant-connections`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workspaceOneWriteToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "malformed-json",
        },
        body: "{",
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ code: "invalid_request" });
    }
  });

  it("tolerates extra request fields", async () => {
    const response = await app.request(`/api/v1/workspaces/${workspaceOneId}/tenant-connections`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${workspaceOneWriteToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "extra-fields",
      },
      body: JSON.stringify({
        credentials: { ...credentials, ignoredNestedField: true },
        ignoredTopLevelField: true,
      }),
    });

    expect(response.status).toBe(202);
  });

  it("rejects whitespace-padded email addresses", async () => {
    const response = await requestValidation(
      workspaceOneId,
      workspaceOneWriteToken,
      "padded-email",
      {
        ...credentials,
        email: ` ${credentials.email} `,
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "invalid_request" });
  });

  it("accepts only Bearer authority even when a browser session is present", async () => {
    const sessionOnly = await app.request(
      `/api/v1/workspaces/${workspaceOneId}/tenant-connections`,
      {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "Content-Type": "application/json",
          "Idempotency-Key": "session-only",
        },
        body: JSON.stringify({ credentials }),
      },
    );
    const bearerWithSession = await app.request(
      `/api/v1/workspaces/${workspaceOneId}/tenant-connections`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${workspaceOneWriteToken}`,
          Cookie: sessionCookie,
          "Content-Type": "application/json",
          "Idempotency-Key": "bearer-with-session",
        },
        body: JSON.stringify({ credentials }),
      },
    );

    expect(sessionOnly.status).toBe(401);
    await expect(sessionOnly.json()).resolves.toEqual({ code: "unauthorized" });
    expect(bearerWithSession.status).toBe(202);
  });

  it("does not disclose or create tenant connections for unauthorized writes", async () => {
    const responses = await Promise.all([
      requestValidation(workspaceOneId, workspaceOneReadToken, "read-key"),
      requestValidation(workspaceOneId, workspaceTwoWriteToken, "wrong-workspace"),
      requestValidation(workspaceOneId, crossOrganizationWriteToken, "cross-organization"),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ code: "not_found" });
    }
    await expect(
      database
        .select()
        .from(tenantConnection)
        .where(eq(tenantConnection.workspaceId, workspaceOneId)),
    ).resolves.toHaveLength(0);
  });

  it("returns safe accepted resources, persists no credential values, and reuses idempotency keys", async () => {
    const first = await requestValidation(workspaceOneId, workspaceOneWriteToken, "same-key");
    const firstBody = await readTenantValidationResponse(first);
    const repeated = await requestValidation(workspaceOneId, workspaceOneWriteToken, "same-key");
    const repeatedBody = await repeated.json();
    const organizationWide = await requestValidation(
      workspaceTwoId,
      organizationWriteToken,
      "organization-write",
    );
    const changed = await requestValidation(workspaceOneId, workspaceOneWriteToken, "same-key", {
      ...credentials,
      password: "changed-password",
    });

    expect(first.status).toBe(202);
    expect(first.headers.get("Idempotency-Key")).toBe("same-key");
    expect(repeated.status).toBe(202);
    expect(repeated.headers.get("Idempotency-Key")).toBe("same-key");
    expect(organizationWide.status).toBe(202);
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toEqual({ code: "idempotency_conflict" });
    expect(firstBody).toMatchObject({
      tenantConnection: { workspaceId: workspaceOneId },
      job: { status: "processing" },
    });
    expect(repeatedBody).toMatchObject({
      job: { id: firstBody.job.id },
    });
    expect(JSON.stringify(firstBody)).not.toContain(credentials.email);
    expect(JSON.stringify(firstBody)).not.toContain(credentials.password);
    expect(JSON.stringify(firstBody)).not.toContain("credentialCiphertext");

    const [storedTenant] = await database
      .select()
      .from(tenantConnection)
      .where(eq(tenantConnection.id, firstBody.tenantConnection.id));
    const storedJob = await database
      .select()
      .from(job)
      .where(eq(job.tenantConnectionId, firstBody.tenantConnection.id));
    const storedIdempotency = await database
      .select()
      .from(idempotencyRecord)
      .where(eq(idempotencyRecord.jobId, firstBody.job.id));
    const storedOutbox = await database
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.jobId, firstBody.job.id));
    const persisted = JSON.stringify([storedTenant, storedJob, storedIdempotency, storedOutbox]);
    expect(persisted).not.toContain(credentials.email);
    expect(persisted).not.toContain(credentials.password);
    expect(storedJob).toHaveLength(1);
    expect(storedIdempotency).toHaveLength(1);
    expect(storedOutbox).toHaveLength(1);
    await expect(
      database
        .select()
        .from(tenantConnection)
        .where(eq(tenantConnection.workspaceId, workspaceOneId)),
    ).resolves.toHaveLength(1);
  });

  it("returns jobs only to workspace-readable keys and never exposes encryption fields", async () => {
    const created = await requestValidation(workspaceOneId, workspaceOneWriteToken, "job-read");
    const createdBody = await readTenantValidationResponse(created);
    const responses = await Promise.all([
      app.request(`/api/v1/jobs/${createdBody.job.id}`, {
        headers: { Authorization: `Bearer ${workspaceOneReadToken}` },
      }),
      app.request(`/api/v1/jobs/${createdBody.job.id}`, {
        headers: { Authorization: `Bearer ${workspaceTwoReadToken}` },
      }),
      app.request(`/api/v1/jobs/${createdBody.job.id}`, {
        headers: { Authorization: `Bearer ${crossOrganizationWriteToken}` },
      }),
      app.request(`/api/v1/jobs/${crypto.randomUUID()}`, {
        headers: { Authorization: `Bearer ${workspaceOneReadToken}` },
      }),
    ]);

    expect(responses[0]?.status).toBe(200);
    const readableBody = await responses[0]?.json();
    expect(JSON.stringify(readableBody)).not.toContain("credentialCiphertext");
    expect(JSON.stringify(readableBody)).not.toContain("credentialIv");
    expect(JSON.stringify(readableBody)).not.toContain("credentialAuthTag");
    expect(JSON.stringify(readableBody)).not.toContain("credentialKeyVersion");
    for (const response of responses.slice(1)) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ code: "not_found" });
    }
  });

  it("projects internal job states to safe public job statuses", async () => {
    const created = await requestValidation(workspaceOneId, workspaceOneWriteToken, "job-status");
    const createdBody = await readTenantValidationResponse(created);
    const jobId = createdBody.job.id;

    expect(created.status).toBe(202);
    expect(createdBody.job.status).toBe("processing");
    expect(Object.keys(createdBody.job).sort()).toEqual(publicJobFields);

    await database
      .update(job)
      .set({
        leaseExpiresAt: new Date(Date.now() + 60_000),
        leaseToken: crypto.randomUUID(),
        state: "running",
      })
      .where(eq(job.id, jobId));
    const running = await app.request(`/api/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${workspaceOneReadToken}` },
    });
    const runningBody = await readTenantValidationResponse(running);

    expect(running.status).toBe(200);
    expect(runningBody.job.status).toBe("processing");

    await database
      .update(job)
      .set({ leaseExpiresAt: null, leaseToken: null, state: "completed" })
      .where(eq(job.id, jobId));
    const completed = await app.request(`/api/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${workspaceOneReadToken}` },
    });
    const completedBody = await readTenantValidationResponse(completed);

    expect(completed.status).toBe(200);
    expect(completedBody.job.status).toBe("completed");

    await database
      .update(job)
      .set({ failureCode: "microsoft_auth_failed", retryable: false, state: "failed" })
      .where(eq(job.id, jobId));
    const failed = await app.request(`/api/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${workspaceOneReadToken}` },
    });
    const failedBody = await readTenantValidationResponse(failed);

    expect(failed.status).toBe(200);
    expect(failedBody.job).toMatchObject({
      failureCode: "microsoft_auth_failed",
      retryable: false,
      status: "failed",
    });

    await database.update(job).set({ state: "cancelled" }).where(eq(job.id, jobId));
    const cancelled = await app.request(`/api/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${workspaceOneReadToken}` },
    });
    const cancelledBody = await readTenantValidationResponse(cancelled);

    expect(cancelled.status).toBe(200);
    expect(cancelledBody.job.status).toBe("failed");

    for (const body of [createdBody, runningBody, completedBody, failedBody, cancelledBody]) {
      expect(Object.keys(body.job).sort()).toEqual(publicJobFields);
      expect(JSON.stringify(body)).not.toContain("leaseToken");
      expect(JSON.stringify(body)).not.toContain("leaseExpiresAt");
      expect(JSON.stringify(body)).not.toContain("availableAt");
      expect(JSON.stringify(body)).not.toContain("attemptCount");
      expect(JSON.stringify(body)).not.toContain("queued");
      expect(JSON.stringify(body)).not.toContain("running");
      expect(JSON.stringify(body)).not.toContain(credentials.email);
      expect(JSON.stringify(body)).not.toContain(credentials.password);
    }
  });
});
