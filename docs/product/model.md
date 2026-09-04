# Product Model

## Ownership

```text
User --< Access Grant (organization or one-workspace scope) >-- Organization --< Workspace
                                                                    --< Subscription / Entitlement / Credits
Workspace --< Tenant Connection --< Domain --< Inbox
```

- An organization owns billing, subscriptions, onboarding credits, tenant slots,
  workspaces, and API keys.
- A workspace owns tenant connections. It is a client/project and permission boundary,
  not a billing boundary.
- A tenant connection belongs to one workspace, owns a distinct tenant-admin credential
  identity, and has at most one active domain. Credentials and Microsoft sessions are never
  shared between tenant connections.
- A tenant supports at most 100 inboxes.
- A discovered Microsoft tenant ID may have only one active platform owner. Duplicate
  validation fails without disclosing the other organization.

## Onboarding And Access

Sign-up requires a company name and atomically creates the user, personal organization,
`Default` workspace, and organization-wide `write` grant. A failed signup creates none
of those records, so the same email can retry.

An access grant has two fields:

| Field      | Values                      | Meaning                                                                                                                                                             |
| ---------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission | `read`, `write`             | `read` views non-secret product state. `write` includes `read`, permits mutations, and is required to reveal stored plaintext passwords.                            |
| Scope      | organization, one workspace | An organization grant covers organization settings, billing, API keys, and every workspace it owns. A workspace grant covers only that workspace and its resources. |

- A user can have multiple grants. Access is allowed when any grant supplies the
  required permission for the resource's scope.
- A workspace grant never grants access to organization-wide billing, API keys, or a
  different workspace.
- There is no separate organization-membership record. An access grant is the user's
  association with an organization or workspace. Creating the personal organization is
  the only onboarding flow that automatically creates one.
- A future invitation creates one or more scoped access grants, not a membership record.
- Organization-wide `write` is intentionally powerful: it can manage billing,
  organization settings, workspaces, tenant connections, domains, inboxes, jobs, and
  API keys.
- Launch grants are deliberately broad. A future grant model may allow resource/action
  permissions within the same scope, such as `write` for domains while retaining `read`
  for tenant connections. Do not simulate that future need with additional roles.

Clients, employees, and VAs are all users with access grants. There is no separate
client identity model.

## API Keys

An opaque API key belongs to one organization. It has one permission (`read` or `write`)
and one scope (organization-wide or exactly one workspace); `write` includes `read`.
Users needing access to multiple workspaces create separate workspace keys. Keys have an
expiry, revocation state, prefix, stored hash, and creator audit record. See
[`../architecture/api.md`](../architecture/api.md).

The API-key backend and the first Bearer workspace-read endpoint are implemented. Customer
API-key issuance remains deferred until deliberate dashboard UI work; no public
issuance/revocation routes exist. There is no granular permission matrix: `write` covers
every implemented write action in scope, while deletion endpoints will be introduced
deliberately later.

## Microsoft Authorization Secrets

The tenant-admin credential model uses a distinct email/password authorization secret pair
for each tenant connection's Microsoft actions. They may be accepted for authorized create
or update, are never revealed, and are removed when a tenant is detached. They are distinct
from a future mailbox-password behavior, where an authorized `write` actor may deliberately
reveal a stored mailbox password.

Tenant validation records a discovered Microsoft tenant ID against its active owner
organization. A collision is a safe public failure that does not identify that owner.

## Entitlements

Billing and Polar integration are deferred. An internal unlimited organization entitlement
will be added with the first tenant-validation command, not as a standalone system.

## Tenant Removal

Removing a tenant detaches it from the platform. The platform removes its stored
Microsoft credentials and sessions, disallows future jobs, and preserves audit history.
It does not necessarily remove Microsoft inboxes or the active domain. A
SaaS-managed Cloudflare zone remains as a detached read-only zone until the customer
explicitly migrates DNS or deletes the domain.

Re-adding the same Microsoft tenant is a new onboarding and consumes a new onboarding
credit after successful validation.
