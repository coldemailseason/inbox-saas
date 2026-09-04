import { accessGrant, apiKey, createDb, organization, user, workspace } from "@inbox-saas/db";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authenticateApiKey, issueApiKey, revokeApiKey } from "../../src/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.includes("test")) {
  throw new Error("TEST_DATABASE_URL must point to an isolated test database");
}

const database = createDb(testDatabaseUrl);

let userId: string;
let organizationOneId: string;
let organizationTwoId: string;
let workspaceOneId: string;
let workspaceTwoId: string;

beforeEach(async () => {
  const suffix = crypto.randomUUID();
  userId = `api-key-user-${suffix}`;

  await database.insert(user).values({
    id: userId,
    name: "API Key User",
    email: `api-key-${suffix}@example.test`,
    initialOrganizationName: "Initial API Key Organization",
  });

  const initialOrganizations = await database
    .select({ organizationId: accessGrant.organizationId })
    .from(accessGrant)
    .where(eq(accessGrant.userId, userId));

  await database.delete(organization).where(
    inArray(
      organization.id,
      initialOrganizations.map((grant) => grant.organizationId),
    ),
  );

  const organizations = await database
    .insert(organization)
    .values([{ name: "API Key Organization One" }, { name: "API Key Organization Two" }])
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
      { name: "API Key Workspace One", organizationId: organizationOneId },
      { name: "API Key Workspace Two", organizationId: organizationTwoId },
    ])
    .returning({ id: workspace.id });
  const [workspaceOne, workspaceTwo] = workspaces;

  if (!workspaceOne || !workspaceTwo) {
    throw new Error("Expected two workspaces");
  }

  workspaceOneId = workspaceOne.id;
  workspaceTwoId = workspaceTwo.id;
});

afterEach(async () => {
  await database
    .delete(organization)
    .where(inArray(organization.id, [organizationOneId, organizationTwoId]));
  await database.delete(user).where(eq(user.id, userId));
});

describe("API keys", () => {
  it("issues an opaque organization read key and authenticates it as an access grant", async () => {
    const issued = await issueApiKey(database, {
      creatorUserId: userId,
      expiresAt: new Date(Date.now() + 60_000),
      organizationId: organizationOneId,
      permission: "read",
      scope: "organization",
    });
    const [stored] = await database.select().from(apiKey).where(eq(apiKey.id, issued.id));

    expect(issued.token).toMatch(/^inbx_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
    expect(stored).toBeDefined();
    expect(stored?.prefix).toBe(issued.prefix);
    expect(stored?.secretHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.values(stored ?? {})).not.toContain(issued.token);
    await expect(authenticateApiKey(database, issued.token)).resolves.toEqual({
      organizationId: organizationOneId,
      permission: "read",
      scope: "organization",
    });
  });

  it("authenticates a workspace write key as a workspace access grant", async () => {
    const issued = await issueApiKey(database, {
      creatorUserId: userId,
      expiresAt: new Date(Date.now() + 60_000),
      organizationId: organizationOneId,
      permission: "write",
      scope: "workspace",
      workspaceId: workspaceOneId,
    });

    await expect(authenticateApiKey(database, issued.token)).resolves.toEqual({
      organizationId: organizationOneId,
      permission: "write",
      scope: "workspace",
      workspaceId: workspaceOneId,
    });
  });

  it("returns null for invalid, changed, expired, revoked, and malformed tokens", async () => {
    const issued = await issueApiKey(database, {
      creatorUserId: userId,
      expiresAt: new Date(Date.now() + 60_000),
      organizationId: organizationOneId,
      permission: "read",
      scope: "organization",
    });
    const changedSecret = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`;

    await expect(authenticateApiKey(database, "inbx_unknown_secret")).resolves.toBeNull();
    await expect(authenticateApiKey(database, changedSecret)).resolves.toBeNull();
    await expect(authenticateApiKey(database, issued.token, issued.expiresAt)).resolves.toBeNull();
    await revokeApiKey(database, issued.id);
    await revokeApiKey(database, issued.id);
    await expect(authenticateApiKey(database, issued.token)).resolves.toBeNull();
    await expect(authenticateApiKey(database, "not-an-api-key")).resolves.toBeNull();
  });

  it("rejects a non-future expiry", async () => {
    await expect(
      issueApiKey(database, {
        creatorUserId: userId,
        expiresAt: new Date(),
        organizationId: organizationOneId,
        permission: "read",
        scope: "organization",
      }),
    ).rejects.toThrow("API key expiry must be in the future");
  });

  it("enforces scope and organization integrity in the database", async () => {
    const expiresAt = new Date(Date.now() + 60_000);

    await expect(
      database.insert(apiKey).values({
        creatorUserId: userId,
        expiresAt,
        organizationId: organizationOneId,
        permission: "read",
        prefix: `organization-scope-${crypto.randomUUID()}`,
        scope: "organization",
        secretHash: crypto.randomUUID(),
        workspaceId: workspaceOneId,
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(apiKey).values({
        creatorUserId: userId,
        expiresAt,
        organizationId: organizationOneId,
        permission: "read",
        prefix: `workspace-scope-${crypto.randomUUID()}`,
        scope: "workspace",
        secretHash: crypto.randomUUID(),
        workspaceId: workspaceTwoId,
      }),
    ).rejects.toThrow();
  });
});
