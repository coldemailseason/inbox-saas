import { accessGrant, organization, workspace, type Database } from "@inbox-saas/db";
import { eq, inArray } from "drizzle-orm";

import { type AccessGrant, isAuthorized } from "./access.js";

function toAccessGrant(grant: typeof accessGrant.$inferSelect): AccessGrant {
  if (grant.scope === "organization") {
    return {
      organizationId: grant.organizationId,
      permission: grant.permission,
      scope: "organization",
    };
  }

  if (!grant.workspaceId) {
    throw new Error("Workspace access grants require a workspace");
  }

  return {
    organizationId: grant.organizationId,
    permission: grant.permission,
    scope: "workspace",
    workspaceId: grant.workspaceId,
  };
}

export async function getUserAccessGrants(
  database: Database,
  userId: string,
): Promise<AccessGrant[]> {
  const grants = await database.select().from(accessGrant).where(eq(accessGrant.userId, userId));

  return grants.map(toAccessGrant);
}

export async function getAccessibleControlPlane(
  database: Database,
  grants: readonly AccessGrant[],
) {
  const organizationIds = [...new Set(grants.map((grant) => grant.organizationId))];

  if (organizationIds.length === 0) {
    return { organizations: [], workspaces: [] };
  }

  const [organizations, workspaces] = await Promise.all([
    database.select().from(organization).where(inArray(organization.id, organizationIds)),
    database.select().from(workspace).where(inArray(workspace.organizationId, organizationIds)),
  ]);

  return {
    organizations: organizations
      .filter((organization) =>
        isAuthorized(grants, {
          organizationId: organization.id,
          permission: "read",
          scope: "organization",
        }),
      )
      .map(({ id, name }) => ({ id, name })),
    workspaces: workspaces
      .filter((workspace) =>
        isAuthorized(grants, {
          organizationId: workspace.organizationId,
          permission: "read",
          scope: "workspace",
          workspaceId: workspace.id,
        }),
      )
      .map(({ id, organizationId, name }) => ({ id, organizationId, name })),
  };
}
