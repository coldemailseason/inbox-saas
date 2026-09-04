import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { apiKey, type Database } from "@inbox-saas/db";
import { and, eq, isNull } from "drizzle-orm";

import { type AccessGrant } from "./access.js";

export type IssueApiKeyInput = AccessGrant & {
  creatorUserId: string;
  expiresAt: Date;
};

export type IssuedApiKey = IssueApiKeyInput & {
  id: string;
  prefix: string;
  token: string;
  createdAt: Date;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toAccessGrant(key: typeof apiKey.$inferSelect): AccessGrant {
  if (key.scope === "organization") {
    return {
      organizationId: key.organizationId,
      permission: key.permission,
      scope: "organization",
    };
  }

  if (!key.workspaceId) {
    throw new Error("Workspace API keys require a workspace");
  }

  return {
    organizationId: key.organizationId,
    permission: key.permission,
    scope: "workspace",
    workspaceId: key.workspaceId,
  };
}

export async function issueApiKey(
  database: Database,
  input: IssueApiKeyInput,
): Promise<IssuedApiKey> {
  const now = new Date();

  if (input.expiresAt <= now) {
    throw new Error("API key expiry must be in the future");
  }

  const prefix = randomBytes(24).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const token = `inbx_${prefix}_${secret}`;
  const [key] = await database
    .insert(apiKey)
    .values({
      creatorUserId: input.creatorUserId,
      expiresAt: input.expiresAt,
      organizationId: input.organizationId,
      permission: input.permission,
      prefix,
      scope: input.scope,
      secretHash: hashToken(token),
      workspaceId: input.scope === "workspace" ? input.workspaceId : null,
    })
    .returning();

  if (!key) {
    throw new Error("Failed to issue API key");
  }

  if (key.scope === "organization") {
    return {
      creatorUserId: key.creatorUserId,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      id: key.id,
      organizationId: key.organizationId,
      permission: key.permission,
      prefix: key.prefix,
      scope: "organization",
      token,
    };
  }

  if (!key.workspaceId) {
    throw new Error("Workspace API keys require a workspace");
  }

  return {
    creatorUserId: key.creatorUserId,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    id: key.id,
    organizationId: key.organizationId,
    permission: key.permission,
    prefix: key.prefix,
    scope: "workspace",
    token,
    workspaceId: key.workspaceId,
  };
}

export async function authenticateApiKey(
  database: Database,
  token: string,
  now = new Date(),
): Promise<AccessGrant | null> {
  const match = /^inbx_([A-Za-z0-9_-]{32})_([A-Za-z0-9_-]{43})$/.exec(token);

  if (!match) {
    return null;
  }

  const prefix = match[1];
  if (!prefix) {
    return null;
  }

  const [key] = await database.select().from(apiKey).where(eq(apiKey.prefix, prefix));
  const tokenHash = hashToken(token);

  if (
    !key ||
    key.secretHash.length !== tokenHash.length ||
    !timingSafeEqual(Buffer.from(key.secretHash), Buffer.from(tokenHash)) ||
    key.revokedAt ||
    key.expiresAt <= now
  ) {
    return null;
  }

  return toAccessGrant(key);
}

export async function revokeApiKey(
  database: Database,
  apiKeyId: string,
  now = new Date(),
): Promise<void> {
  await database
    .update(apiKey)
    .set({ revokedAt: now })
    .where(and(eq(apiKey.id, apiKeyId), isNull(apiKey.revokedAt)));
}
