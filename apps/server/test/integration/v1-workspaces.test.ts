import { createAuth } from "@inbox-saas/auth";
import { accessGrant, apiKey, createDb, organization, user, workspace } from "@inbox-saas/db";
import { createTenantCredentialCipher, issueApiKey, revokeApiKey } from "@inbox-saas/product";
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

let userId: string;
let organizationOneId: string;
let organizationTwoId: string;
let workspaceOneId: string;
let workspaceTwoId: string;
let sessionCookie: string;
let organizationReadToken: string;
let workspaceReadToken: string;
let workspaceWriteToken: string;
let expiredToken: string;
let revokedToken: string;

async function signUp() {
  const suffix = crypto.randomUUID();
  const response = await auth.handler(
    new Request("http://localhost:3001/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
      },
      body: JSON.stringify({
        email: `v1-workspaces-${suffix}@example.test`,
        name: "V1 Workspaces User",
        password: "a-secure-test-password",
        initialOrganizationName: "V1 Initial Organization",
      }),
    }),
  );

  expect(response.ok).toBe(true);
  const cookie = response.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("Expected signup to create a session cookie");
  }

  sessionCookie = cookie.split(";", 1)[0] ?? "";
  const [createdUser] = await database
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, `v1-workspaces-${suffix}@example.test`));
  if (!createdUser) {
    throw new Error("Expected signup to create a user");
  }

  userId = createdUser.id;
  const session = await auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) });
  expect(session?.user.id).toBe(userId);
}

beforeEach(async () => {
  await signUp();

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
    .values([{ name: "Organization One" }, { name: "Organization Two" }])
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
      { name: "Workspace One", organizationId: organizationOneId },
      { name: "Workspace Two", organizationId: organizationOneId },
      { name: "Workspace Three", organizationId: organizationTwoId },
    ])
    .returning({ id: workspace.id });
  const [workspaceOne, workspaceTwo, workspaceThree] = workspaces;
  if (!workspaceOne || !workspaceTwo || !workspaceThree) {
    throw new Error("Expected three workspaces");
  }

  workspaceOneId = workspaceOne.id;
  workspaceTwoId = workspaceTwo.id;
  await database.insert(accessGrant).values({
    userId,
    organizationId: organizationOneId,
    permission: "read",
    scope: "organization",
  });
  const expiresAt = new Date(Date.now() + 60_000);
  organizationReadToken = (
    await issueApiKey(database, {
      creatorUserId: userId,
      expiresAt,
      organizationId: organizationOneId,
      permission: "read",
      scope: "organization",
    })
  ).token;
  workspaceReadToken = (
    await issueApiKey(database, {
      creatorUserId: userId,
      expiresAt,
      organizationId: organizationOneId,
      permission: "read",
      scope: "workspace",
      workspaceId: workspaceOneId,
    })
  ).token;
  workspaceWriteToken = (
    await issueApiKey(database, {
      creatorUserId: userId,
      expiresAt,
      organizationId: organizationOneId,
      permission: "write",
      scope: "workspace",
      workspaceId: workspaceTwoId,
    })
  ).token;
  const expired = await issueApiKey(database, {
    creatorUserId: userId,
    expiresAt,
    organizationId: organizationOneId,
    permission: "read",
    scope: "organization",
  });
  expiredToken = expired.token;
  await database
    .update(apiKey)
    .set({
      createdAt: new Date(Date.now() - 2_000),
      expiresAt: new Date(Date.now() - 1_000),
    })
    .where(eq(apiKey.id, expired.id));

  const revoked = await issueApiKey(database, {
    creatorUserId: userId,
    expiresAt,
    organizationId: organizationOneId,
    permission: "read",
    scope: "organization",
  });
  revokedToken = revoked.token;
  await revokeApiKey(database, revoked.id);
});

afterEach(async () => {
  await database
    .delete(organization)
    .where(inArray(organization.id, [organizationOneId, organizationTwoId]));
  await database.delete(user).where(eq(user.id, userId));
});

describe("GET /api/v1/workspaces", () => {
  it("returns workspaces permitted by organization, workspace, and write keys", async () => {
    const organizationResponse = await app.request("/api/v1/workspaces", {
      headers: { Authorization: `Bearer ${organizationReadToken}` },
    });
    const workspaceResponse = await app.request("/api/v1/workspaces", {
      headers: { Authorization: `Bearer ${workspaceReadToken}` },
    });
    const writeResponse = await app.request("/api/v1/workspaces", {
      headers: { Authorization: `Bearer ${workspaceWriteToken}` },
    });

    await expect(organizationResponse.json()).resolves.toEqual({
      workspaces: expect.arrayContaining([
        { id: workspaceOneId, name: "Workspace One", organizationId: organizationOneId },
        { id: workspaceTwoId, name: "Workspace Two", organizationId: organizationOneId },
      ]),
    });
    expect(organizationResponse.status).toBe(200);
    expect(await workspaceResponse.json()).toEqual({
      workspaces: [
        { id: workspaceOneId, name: "Workspace One", organizationId: organizationOneId },
      ],
    });
    expect(workspaceResponse.status).toBe(200);
    expect(await writeResponse.json()).toEqual({
      workspaces: [
        { id: workspaceTwoId, name: "Workspace Two", organizationId: organizationOneId },
      ],
    });
    expect(writeResponse.status).toBe(200);
  });

  it("returns indistinguishable failures for invalid API keys", async () => {
    const responses = await Promise.all([
      app.request("/api/v1/workspaces"),
      app.request("/api/v1/workspaces", { headers: { Authorization: "Basic credentials" } }),
      app.request("/api/v1/workspaces", { headers: { Authorization: "Bearer malformed token" } }),
      app.request("/api/v1/workspaces", {
        headers: { Authorization: `Bearer inbx_${"a".repeat(32)}_${"b".repeat(43)}` },
      }),
      app.request("/api/v1/workspaces", { headers: { Authorization: `Bearer ${expiredToken}` } }),
      app.request("/api/v1/workspaces", { headers: { Authorization: `Bearer ${revokedToken}` } }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      await expect(response.json()).resolves.toEqual({ code: "unauthorized" });
    }
  });

  it("ignores browser session authority in favor of the Bearer key", async () => {
    const sessionOnlyResponse = await app.request("/api/v1/workspaces", {
      headers: { Cookie: sessionCookie },
    });
    const combinedResponse = await app.request("/api/v1/workspaces", {
      headers: {
        Authorization: `Bearer ${workspaceReadToken}`,
        Cookie: sessionCookie,
      },
    });

    expect(sessionOnlyResponse.status).toBe(401);
    expect(sessionOnlyResponse.headers.get("WWW-Authenticate")).toBe("Bearer");
    await expect(sessionOnlyResponse.json()).resolves.toEqual({ code: "unauthorized" });
    await expect(combinedResponse.json()).resolves.toEqual({
      workspaces: [
        { id: workspaceOneId, name: "Workspace One", organizationId: organizationOneId },
      ],
    });
    expect(combinedResponse.status).toBe(200);
  });
});

describe("POST /rpc/controlPlane", () => {
  it("uses browser sessions and the injected database, not Bearer API keys", async () => {
    const sessionResponse = await app.request("/rpc/controlPlane", {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
    const bearerResponse = await app.request("/rpc/controlPlane", {
      method: "POST",
      headers: { Authorization: `Bearer ${organizationReadToken}` },
    });

    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toEqual({
      json: {
        organizations: [{ id: organizationOneId, name: "Organization One" }],
        workspaces: [
          { id: workspaceOneId, name: "Workspace One", organizationId: organizationOneId },
          { id: workspaceTwoId, name: "Workspace Two", organizationId: organizationOneId },
        ],
      },
    });
    expect(bearerResponse.status).toBe(401);
  });
});
