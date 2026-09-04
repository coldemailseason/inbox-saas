CREATE TYPE "public"."job_operation" AS ENUM('tenant_validation');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."outbox_event_type" AS ENUM('tenant_validation_requested');--> statement-breakpoint
CREATE TYPE "public"."tenant_connection_state" AS ENUM('validating', 'active', 'validation_failed', 'detached');--> statement-breakpoint
CREATE TABLE "idempotency_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"operation" "job_operation" NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_record_organization_key_unique" UNIQUE("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_connection_id" uuid NOT NULL,
	"state" "job_state" NOT NULL,
	"operation" "job_operation" NOT NULL,
	"failure_code" text,
	"retryable" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"type" "outbox_event_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"dispatched_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"state" "tenant_connection_state" NOT NULL,
	"microsoft_tenant_id" text,
	"credential_ciphertext" "bytea" NOT NULL,
	"credential_iv" "bytea" NOT NULL,
	"credential_auth_tag" "bytea" NOT NULL,
	"credential_key_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_tenant_connection_id_tenant_connection_id_fk" FOREIGN KEY ("tenant_connection_id") REFERENCES "public"."tenant_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_connection" ADD CONSTRAINT "tenant_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_connection" ADD CONSTRAINT "tenant_connection_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspace"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_non_terminal_tenant_connection_uidx" ON "job" USING btree ("tenant_connection_id") WHERE "job"."state" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_connection_active_microsoft_tenant_uidx" ON "tenant_connection" USING btree ("microsoft_tenant_id") WHERE "tenant_connection"."state" = 'active';