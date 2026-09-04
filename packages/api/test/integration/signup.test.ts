import { createAuth } from "@inbox-saas/auth";
import { accessGrant, createDb, organization, user, workspace } from "@inbox-saas/db";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl || !new URL(testDatabaseUrl).pathname.includes("test")) {
  throw new Error("TEST_DATABASE_URL must point to an isolated test database");
}

const database = createDb(testDatabaseUrl);
const auth = createAuth(database);
const createdEmails: string[] = [];

async function signUp(email: string, initialOrganizationName: string) {
  createdEmails.push(email);

  return auth.handler(
    new Request("http://localhost:3001/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
      },
      body: JSON.stringify({
        email,
        name: "Test User",
        password: "a-secure-test-password",
        initialOrganizationName,
      }),
    }),
  );
}

afterEach(async () => {
  if (createdEmails.length === 0) {
    return;
  }

  const users = await database
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.email, createdEmails));
  const userIds = users.map((user) => user.id);

  if (userIds.length > 0) {
    const grants = await database
      .select({ organizationId: accessGrant.organizationId })
      .from(accessGrant)
      .where(inArray(accessGrant.userId, userIds));

    await database.delete(organization).where(
      inArray(
        organization.id,
        grants.map((grant) => grant.organizationId),
      ),
    );
    await database.delete(user).where(inArray(user.id, userIds));
  }

  createdEmails.length = 0;
});

describe("email signup", () => {
  it("creates the initial organization, workspace, and organization-wide write grant", async () => {
    const suffix = crypto.randomUUID();
    const email = `signup-${suffix}@example.test`;
    const response = await signUp(email, "  Example Company  ");

    expect(response.ok).toBe(true);

    const [createdUser] = await database.select().from(user).where(eq(user.email, email));
    const grants = await database
      .select()
      .from(accessGrant)
      .where(eq(accessGrant.userId, createdUser.id));
    const [createdOrganization] = await database
      .select()
      .from(organization)
      .where(eq(organization.id, grants[0].organizationId));
    const workspaces = await database
      .select()
      .from(workspace)
      .where(eq(workspace.organizationId, createdOrganization.id));

    expect(createdUser.initialOrganizationName).toBe("Example Company");
    expect(createdOrganization.name).toBe("Example Company");
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].name).toBe("Default");
    expect(grants).toEqual([
      expect.objectContaining({
        organizationId: createdOrganization.id,
        permission: "write",
        scope: "organization",
        workspaceId: null,
      }),
    ]);
  });

  it("does not create an account when the initial control plane cannot be created", async () => {
    const suffix = crypto.randomUUID();
    const email = `failed-signup-${suffix}@example.test`;

    await database.execute(
      sql`ALTER TABLE organization ADD CONSTRAINT signup_test_failure CHECK (name <> 'Failed Signup Company')`,
    );

    try {
      const response = await signUp(email, "Failed Signup Company");

      expect(response.ok).toBe(false);
      expect(await database.select().from(user).where(eq(user.email, email))).toEqual([]);
    } finally {
      await database.execute(sql`ALTER TABLE organization DROP CONSTRAINT signup_test_failure`);
    }

    expect((await signUp(email, "Failed Signup Company")).ok).toBe(true);
  });
});
