export type OrganizationEntitlement = {
  organizationId: string;
  entitled: true;
  limit: "unlimited";
};

export function getOrganizationEntitlement(organizationId: string): OrganizationEntitlement {
  if (!organizationId) {
    throw new Error("Organization ID is required");
  }

  return { organizationId, entitled: true, limit: "unlimited" };
}
