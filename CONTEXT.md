# Product Context

## Purpose

This product provisions and manages Microsoft 365 cold-email infrastructure.

## Terms

- **User**: a person who belongs to one or more organizations.
- **Organization**: a shared customer account and the billing and ownership boundary.
  Every user receives a personal organization during onboarding and can receive access
  grants to shared organizations.
- **Access grant**: a user's `read` or `write` permission over either an entire
  organization or one workspace. `write` includes `read` within the same scope. Future
  invitations create one or more scoped grants.
- **Workspace**: a client or project container inside one organization. Workspaces are
  permission boundaries, never billing units.
- **Tenant connection**: the platform record for one managed Microsoft 365 tenant. It
  belongs to exactly one workspace. A real Microsoft tenant can have only one active
  platform owner globally.
- **Tenant-admin credentials**: a distinct, non-retrievable email/password authorization
  secret pair supplied for one tenant connection's Microsoft actions. Credentials are never
  shared between tenant connections.
- **Tenant session**: an ephemeral, tenant-scoped execution context for Microsoft
  actions. It is isolated to one tenant connection and never shared.
- **Domain**: the single active custom domain for a tenant connection. A tenant must
  finish deleting its active domain before adding another.
- **DNS mode**: either `saas_managed_zone`, where the SaaS owns a Cloudflare zone, or
  `external_manual`, where the customer applies supplied Microsoft records.
- **Inbox**: one provisioned Microsoft mailbox under a tenant's active domain. A tenant
  supports at most 100 inboxes.
- **Inbox plan**: an immutable generated list of inboxes that a customer or agent
  confirms before mailbox creation begins.
- **Job**: durable asynchronous work. Customer-facing status is `processing`,
  `completed`, or `failed`; internal state is more detailed.
- **Onboarding credit**: one non-expiring credit consumed after successful Microsoft
  tenant validation.
- **Tenant slot**: capacity granted by an organization subscription for one active
  tenant connection.
- **Detached tenant**: a tenant removed from the platform while its Microsoft resources
  may continue to exist. It has no stored credentials, sessions, or permitted jobs.
- **API key**: a credential that grants `read` or `write` permission over either an
  organization or one workspace.
