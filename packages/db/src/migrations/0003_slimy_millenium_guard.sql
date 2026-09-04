CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid,
	"permission" "access_grant_permission" NOT NULL,
	"scope" "access_grant_scope" NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_prefix_unique" UNIQUE("prefix"),
	CONSTRAINT "api_key_secret_hash_unique" UNIQUE("secret_hash"),
	CONSTRAINT "api_key_scope_workspace_check" CHECK (("api_key"."scope" = 'organization' AND "api_key"."workspace_id" IS NULL) OR ("api_key"."scope" = 'workspace' AND "api_key"."workspace_id" IS NOT NULL)),
	CONSTRAINT "api_key_expiry_check" CHECK ("api_key"."expires_at" > "api_key"."created_at")
);
--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_creator_user_id_user_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspace"("id","organization_id") ON DELETE cascade ON UPDATE no action;