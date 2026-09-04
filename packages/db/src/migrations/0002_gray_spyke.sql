ALTER TABLE "user" ADD COLUMN "initial_organization_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_initial_organization_name_check" CHECK (char_length("user"."initial_organization_name") BETWEEN 2 AND 100 AND "user"."initial_organization_name" = btrim("user"."initial_organization_name"));--> statement-breakpoint
CREATE FUNCTION create_initial_control_plane() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  organization_id uuid;
BEGIN
  INSERT INTO organization (name)
  VALUES (NEW.initial_organization_name)
  RETURNING id INTO organization_id;

  INSERT INTO workspace (organization_id, name)
  VALUES (organization_id, 'Default');

  INSERT INTO access_grant (user_id, organization_id, permission, scope)
  VALUES (NEW.id, organization_id, 'write', 'organization');

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER create_initial_control_plane_after_user_insert
AFTER INSERT ON "user"
FOR EACH ROW
EXECUTE FUNCTION create_initial_control_plane();
