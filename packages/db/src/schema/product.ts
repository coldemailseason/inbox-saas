import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

const binary = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const accessGrantPermission = pgEnum("access_grant_permission", ["read", "write"]);
export const accessGrantScope = pgEnum("access_grant_scope", ["organization", "workspace"]);
export const tenantConnectionState = pgEnum("tenant_connection_state", [
  "validating",
  "active",
  "validation_failed",
  "detached",
]);
export const jobState = pgEnum("job_state", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const jobOperation = pgEnum("job_operation", ["tenant_validation"]);
export const outboxEventType = pgEnum("outbox_event_type", ["tenant_validation_requested"]);

export const organization = pgTable("organization", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const workspace = pgTable(
  "workspace",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    unique("workspace_id_organization_id_unique").on(table.id, table.organizationId),
    index("workspace_organization_id_idx").on(table.organizationId),
  ],
);

export const accessGrant = pgTable(
  "access_grant",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    permission: accessGrantPermission("permission").notNull(),
    scope: accessGrantScope("scope").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    check(
      "access_grant_scope_workspace_check",
      sql`(${table.scope} = 'organization' AND ${table.workspaceId} IS NULL) OR (${table.scope} = 'workspace' AND ${table.workspaceId} IS NOT NULL)`,
    ),
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspace.id, workspace.organizationId],
      name: "access_grant_workspace_organization_fk",
    }).onDelete("cascade"),
    uniqueIndex("access_grant_organization_uidx")
      .on(table.userId, table.organizationId, table.permission)
      .where(sql`${table.scope} = 'organization'`),
    uniqueIndex("access_grant_workspace_uidx")
      .on(table.userId, table.organizationId, table.workspaceId, table.permission)
      .where(sql`${table.scope} = 'workspace'`),
    index("access_grant_user_id_idx").on(table.userId),
  ],
);

export const apiKey = pgTable(
  "api_key",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    prefix: text("prefix").notNull().unique(),
    secretHash: text("secret_hash").notNull().unique(),
    creatorUserId: text("creator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    permission: accessGrantPermission("permission").notNull(),
    scope: accessGrantScope("scope").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "api_key_scope_workspace_check",
      sql`(${table.scope} = 'organization' AND ${table.workspaceId} IS NULL) OR (${table.scope} = 'workspace' AND ${table.workspaceId} IS NOT NULL)`,
    ),
    check("api_key_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspace.id, workspace.organizationId],
      name: "api_key_workspace_organization_fk",
    }).onDelete("cascade"),
  ],
);

export const tenantConnection = pgTable(
  "tenant_connection",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id").notNull(),
    state: tenantConnectionState("state").notNull(),
    microsoftTenantId: text("microsoft_tenant_id"),
    credentialCiphertext: binary("credential_ciphertext").notNull(),
    credentialIv: binary("credential_iv").notNull(),
    credentialAuthTag: binary("credential_auth_tag").notNull(),
    credentialKeyVersion: text("credential_key_version").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.organizationId],
      foreignColumns: [workspace.id, workspace.organizationId],
      name: "tenant_connection_workspace_organization_fk",
    }).onDelete("cascade"),
    uniqueIndex("tenant_connection_active_microsoft_tenant_uidx")
      .on(table.microsoftTenantId)
      .where(sql`${table.state} = 'active'`),
  ],
);

export const job = pgTable(
  "job",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantConnectionId: uuid("tenant_connection_id")
      .notNull()
      .references(() => tenantConnection.id, { onDelete: "cascade" }),
    state: jobState("state").notNull(),
    operation: jobOperation("operation").notNull(),
    failureCode: text("failure_code"),
    retryable: boolean("retryable"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    leaseExpiresAt: timestamp("lease_expires_at"),
    leaseToken: uuid("lease_token"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("job_non_terminal_tenant_connection_uidx")
      .on(table.tenantConnectionId)
      .where(sql`${table.state} IN ('queued', 'running')`),
  ],
);

export const idempotencyRecord = pgTable(
  "idempotency_record",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    operation: jobOperation("operation").notNull(),
    payloadFingerprint: text("payload_fingerprint").notNull(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("idempotency_record_organization_key_unique").on(table.organizationId, table.key),
  ],
);

export const outboxEvent = pgTable("outbox_event", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobId: uuid("job_id")
    .notNull()
    .references(() => job.id, { onDelete: "cascade" }),
  type: outboxEventType("type").notNull(),
  payload: jsonb("payload").$type<{ jobId: string }>().notNull(),
  dispatchedAt: timestamp("dispatched_at"),
  availableAt: timestamp("available_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const organizationRelations = relations(organization, ({ many }) => ({
  workspaces: many(workspace),
  accessGrants: many(accessGrant),
}));

export const workspaceRelations = relations(workspace, ({ one, many }) => ({
  organization: one(organization, {
    fields: [workspace.organizationId],
    references: [organization.id],
  }),
  accessGrants: many(accessGrant),
}));

export const accessGrantRelations = relations(accessGrant, ({ one }) => ({
  user: one(user, {
    fields: [accessGrant.userId],
    references: [user.id],
  }),
  organization: one(organization, {
    fields: [accessGrant.organizationId],
    references: [organization.id],
  }),
  workspace: one(workspace, {
    fields: [accessGrant.workspaceId],
    references: [workspace.id],
  }),
}));
