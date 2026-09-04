ALTER TABLE "job" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "available_at" timestamp DEFAULT now() NOT NULL;