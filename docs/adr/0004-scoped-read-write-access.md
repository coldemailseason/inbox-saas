# ADR 0004: Scoped Read/Write Access

## Status

Accepted.

## Decision

Users and API keys use the same simple access model. Each access grant has one
permission, `read` or `write`, and one scope: an entire organization or exactly one
workspace. `write` includes `read` within that scope.

Organization-wide access covers organization settings, billing, API keys, and all
workspaces. Workspace access covers only resources that belong to that workspace.
`read` excludes stored plaintext passwords; password-reveal endpoints require `write`.

## Consequences

- The product has no owner, admin, member, manager, operator, or viewer roles.
- The product has no separate organization-membership record; user access grants are
  the organization association.
- Users can receive multiple grants, such as organization `read` plus workspace
  `write`; any matching grant can authorize a request.
- Creating a personal organization grants its creator organization-wide `write` access.
- API keys use the same two-axis model, avoiding per-action scope matrices.
- A future intentional extension can add resource/action permissions within the same
  scope, such as `write` for domains and `read` for tenant connections. It must not
  accumulate special roles to express that policy.
