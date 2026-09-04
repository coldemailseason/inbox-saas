import { accessGrant, createDb, organization, user, workspace } from "@inbox-saas/db";
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAccessibleControlPlane, getUserAccessGrants } from "../../src/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.includes("test")) {
  throw new Error("TEST_DATABASE_URL must point to an isolated test database");
}

const database = createDb(testDatabaseUrl);

let userOneId: string;
let userTwoId: string;
let organizationOneId: string;
let organizationTwoId: string;
let organizationThreeId: string;
let workspaceOneId: string;
let workspaceTwoId: string;
let workspaceTwoSiblingId: string;
let workspaceThreeId: string;

beforeEach(async () => {
  const suffix = crypto.randomUUID();
  userOneId = `user-one-${suffix}`;
  userTwoId = `user-two-${suffix}`;

  await database.insert(user).values([
    {
      id: userOneId,
      name: "User One",
      email: `one-${suffix}@example.test`,
      initialOrganizationName: "Initial Organization One",
    },
    {
      id: userTwoId,
      name: "User Two",
      email: `two-${suffix}@example.test`,
      initialOrganizationName: "Initial Organization Two",
    },
  ]);

  const generatedOrganizationIds = await database
    .select({ organizationId: accessGrant.organizationId })
    .from(accessGrant)
    .where(inArray(accessGrant.userId, [userOneId, userTwoId]));

  await database.delete(organization).where(
    inArray(
      organization.id,
      generatedOrganizationIds.map((grant) => grant.organizationId),
    ),
  );

  const organizations = await database
    .insert(organization)
    .values([
      { name: "Organization One" },
      { name: "Organization Two" },
      { name: "Organization Three" },
    ])
    .returning({ id: organization.id });

  const [organizationOne, organizationTwo, organizationThree] = organizations;

  if (!organizationOne || !organizationTwo || !organizationThree) {
    throw new Error("Expected three organizations");
  }

  organizationOneId = organizationOne.id;
  organizationTwoId = organizationTwo.id;
  organizationThreeId = organizationThree.id;

  const workspaces = await database
    .insert(workspace)
    .values([
      { name: "Workspace One", organizationId: organizationOneId },
      { name: "Workspace Two", organizationId: organizationTwoId },
      { name: "Workspace Two Sibling", organizationId: organizationTwoId },
      { name: "Workspace Three", organizationId: organizationThreeId },
    ])
    .returning({ id: workspace.id });

  const [workspaceOne, workspaceTwo, workspaceTwoSibling, workspaceThree] = workspaces;

  if (!workspaceOne || !workspaceTwo || !workspaceTwoSibling || !workspaceThree) {
    throw new Error("Expected four workspaces");
  }

  workspaceOneId = workspaceOne.id;
  workspaceTwoId = workspaceTwo.id;
  workspaceTwoSiblingId = workspaceTwoSibling.id;
  workspaceThreeId = workspaceThree.id;
});

afterEach(async () => {
  await database
    .delete(organization)
    .where(inArray(organization.id, [organizationOneId, organizationTwoId, organizationThreeId]));
  await database.delete(user).where(inArray(user.id, [userOneId, userTwoId]));
});

describe("getAccessibleControlPlane", () => {
  it("returns only resources authorized by organization and workspace grants", async () => {
    await database.insert(accessGrant).values([
      {
        userId: userOneId,
        organizationId: organizationOneId,
        permission: "read",
        scope: "organization",
      },
      {
        userId: userOneId,
        organizationId: organizationTwoId,
        workspaceId: workspaceTwoId,
        permission: "write",
        scope: "workspace",
      },
      {
        userId: userTwoId,
        organizationId: organizationThreeId,
        permission: "write",
        scope: "organization",
      },
    ]);

    const grants = await getUserAccessGrants(database, userOneId);
    const controlPlane = await getAccessibleControlPlane(database, grants);

    expect(controlPlane.organizations.map((organization) => organization.id)).toEqual([
      organizationOneId,
    ]);
    expect(controlPlane.workspaces.map((workspace) => workspace.id).sort()).toEqual(
      [workspaceOneId, workspaceTwoId].sort(),
    );
    expect(controlPlane.workspaces.map((workspace) => workspace.id)).not.toContain(
      workspaceThreeId,
    );
    expect(controlPlane.workspaces.map((workspace) => workspace.id)).not.toContain(
      workspaceTwoSiblingId,
    );
  });

  it("rejects a workspace grant that names a different organization", async () => {
    await expect(
      database.insert(accessGrant).values({
        userId: userOneId,
        organizationId: organizationOneId,
        workspaceId: workspaceTwoId,
        permission: "read",
        scope: "workspace",
      }),
    ).rejects.toThrow();
  });

  it("rejects organization grants that name a workspace", async () => {
    await expect(
      database.insert(accessGrant).values({
        userId: userOneId,
        organizationId: organizationOneId,
        workspaceId: workspaceOneId,
        permission: "read",
        scope: "organization",
      }),
    ).rejects.toThrow();
  });

  it("returns no resources for a user without grants", async () => {
    const grants = await getUserAccessGrants(database, userOneId);
    const controlPlane = await getAccessibleControlPlane(database, grants);

    expect(controlPlane).toEqual({ organizations: [], workspaces: [] });
  });
});
