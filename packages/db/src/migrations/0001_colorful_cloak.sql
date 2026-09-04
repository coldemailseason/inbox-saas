CREATE TYPE "public"."access_grant_permission" AS ENUM('read', 'write');--> statement-breakpoint
CREATE TYPE "public"."access_grant_scope" AS ENUM('organization', 'workspace');--> statement-breakpoint
CREATE TABLE "access_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid,
	"permission" "access_grant_permission" NOT NULL,
	"scope" "access_grant_scope" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "access_grant_scope_workspace_check" CHECK (("access_grant"."scope" = 'organization' AND "access_grant"."workspace_id" IS NULL) OR ("access_grant"."scope" = 'workspace' AND "access_grant"."workspace_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_id_organization_id_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspace"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_grant_organization_uidx" ON "access_grant" USING btree ("user_id","organization_id","permission") WHERE "access_grant"."scope" = 'organization';--> statement-breakpoint
CREATE UNIQUE INDEX "access_grant_workspace_uidx" ON "access_grant" USING btree ("user_id","organization_id","workspace_id","permission") WHERE "access_grant"."scope" = 'workspace';--> statement-breakpoint
CREATE INDEX "access_grant_user_id_idx" ON "access_grant" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspace_organization_id_idx" ON "workspace" USING btree ("organization_id");