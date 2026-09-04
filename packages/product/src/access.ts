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

function isAccessRecord(value: unknown): value is AccessGrant {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  if (
    typeof record.organizationId !== "string" ||
    (record.permission !== "read" && record.permission !== "write")
  ) {
    return false;
  }

  return (
    record.scope === "organization" ||
    (record.scope === "workspace" && typeof record.workspaceId === "string")
  );
}

export function isAuthorized(grants: readonly AccessGrant[], request: AccessRequest): boolean {
  if (!Array.isArray(grants) || !isAccessRecord(request)) {
    return false;
  }

  return grants.some((grant) => {
    if (!isAccessRecord(grant) || grant.organizationId !== request.organizationId) {
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
