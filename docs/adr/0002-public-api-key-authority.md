# ADR 0002: Opaque Scoped API Keys

## Status

Accepted.

## Decision

The public API uses opaque API keys sent through `Authorization: Bearer <key>`. Keys are
stored hashed and have a prefix, creator audit record, expiry, revocation state, one
permission (`read` or `write`), and one authority boundary: the whole organization or
exactly one workspace. `write` includes `read` within the same scope.

## Consequences

- The product supports delegation to VAs without sharing browser sessions or broad
  organization credentials.
- Launch avoids OAuth, JWT issuance, mutable current-workspace state, action-scope
  matrices, and multi-workspace key join tables.
- Collection and action endpoints explicitly select a workspace; individual resources
  resolve their workspace server-side and are checked against the key boundary.
- A future selected-workspace allowlist can extend this model if customers need it.
