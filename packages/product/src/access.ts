export type Permission = "read" | "write";

export type OrganizationAccessScope = {
  scope: "organization";
};

export type WorkspaceAccessScope = {
  scope: "workspace";
  workspaceId: string;
};

type AccessScope = OrganizationAccessScope | WorkspaceAccessScope;

export type AccessGrant = AccessScope & {
  organizationId: string;
  permission: Permission;
};

export type AccessRequest = AccessScope & {
  organizationId: string;
  permission: Permission;
};

export function isAuthorized(grants: readonly AccessGrant[], request: AccessRequest): boolean {
  return grants.some((grant) => {
    if (grant.organizationId !== request.organizationId) {
      return false;
    }

    if (grant.permission === "read" && request.permission !== "read") {
      return false;
    }

    if (grant.scope === "organization") {
      return true;
    }

    return request.scope === "workspace" && grant.workspaceId === request.workspaceId;
  });
}
