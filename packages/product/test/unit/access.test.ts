import { describe, expect, it } from "vitest";

import { type AccessGrant, isAuthorized } from "../../src/index.js";

describe("isAuthorized", () => {
  it("allows an organization write grant to access organization and workspace resources", () => {
    const grants: AccessGrant[] = [
      { organizationId: "organization-1", scope: "organization", permission: "write" },
    ];

    expect(
      isAuthorized(grants, {
        organizationId: "organization-1",
        scope: "organization",
        permission: "read",
      }),
    ).toBe(true);
    expect(
      isAuthorized(grants, {
        organizationId: "organization-1",
        scope: "organization",
        permission: "write",
      }),
    ).toBe(true);
    expect(
      isAuthorized(grants, {
        organizationId: "organization-1",
        scope: "workspace",
        workspaceId: "workspace-1",
        permission: "read",
      }),
    ).toBe(true);
    expect(
      isAuthorized(grants, {
        organizationId: "organization-1",
        scope: "workspace",
        workspaceId: "workspace-1",
        permission: "write",
      }),
    ).toBe(true);
  });

  it("allows a workspace read grant only for reads in its workspace", () => {
    const grants: AccessGrant[] = [
      {
        organizationId: "organization-1",
        scope: "workspace",
        workspaceId: "workspace-1",
        permission: "read",
      },
    ];

    expect(
      isAuthorized(grants, {
        organizationId: "organization-1",
        scope: "workspace",
        workspaceId: "workspace-1",
        permission: "read",
      }),
    ).toBe(true);
    expect(
      isAuthorized(grants, {
        organizationId: "organization-1",
        scope: "workspace",
        workspaceId: "workspace-2",
        permission: "read",
      }),
    ).toBe(false);
    expect(
      isAuthorized(grants, {
        organizationId: "organization-1",
        scope: "organization",
        permission: "read",
      }),
    ).toBe(false);
  });

  it("does not allow a workspace read grant to write", () => {
    expect(
      isAuthorized(
        [
          {
            organizationId: "organization-1",
            scope: "workspace",
            workspaceId: "workspace-1",
            permission: "read",
          },
        ],
        {
          organizationId: "organization-1",
          scope: "workspace",
          workspaceId: "workspace-1",
          permission: "write",
        },
      ),
    ).toBe(false);
  });

  it("allows a workspace write grant to read in its workspace", () => {
    expect(
      isAuthorized(
        [
          {
            organizationId: "organization-1",
            scope: "workspace",
            workspaceId: "workspace-1",
            permission: "write",
          },
        ],
        {
          organizationId: "organization-1",
          scope: "workspace",
          workspaceId: "workspace-1",
          permission: "read",
        },
      ),
    ).toBe(true);
  });

  it("does not allow an organization read grant to write", () => {
    const grants: AccessGrant[] = [
      { organizationId: "organization-1", scope: "organization", permission: "read" },
    ];

    expect(
      isAuthorized(grants, {
        organizationId: "organization-1",
        scope: "organization",
        permission: "write",
      }),
    ).toBe(false);
    expect(
      isAuthorized(grants, {
        organizationId: "organization-1",
        scope: "workspace",
        workspaceId: "workspace-1",
        permission: "write",
      }),
    ).toBe(false);
  });

  it("does not allow grants to cross organizations", () => {
    expect(
      isAuthorized(
        [{ organizationId: "organization-1", scope: "organization", permission: "write" }],
        {
          organizationId: "organization-2",
          scope: "workspace",
          workspaceId: "workspace-1",
          permission: "write",
        },
      ),
    ).toBe(false);
  });

  it("allows access when any grant matches the request", () => {
    expect(
      isAuthorized(
        [
          { organizationId: "organization-1", scope: "organization", permission: "read" },
          {
            organizationId: "organization-1",
            scope: "workspace",
            workspaceId: "workspace-2",
            permission: "write",
          },
        ],
        {
          organizationId: "organization-1",
          scope: "workspace",
          workspaceId: "workspace-2",
          permission: "write",
        },
      ),
    ).toBe(true);
  });
});
