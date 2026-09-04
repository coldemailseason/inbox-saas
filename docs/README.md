# Internal Documentation

These documents are the canonical context for engineers and agents. Read the smallest
document that covers the current task, then follow its links for dependent decisions.

## Start Here

- Product terminology: [`../CONTEXT.md`](../CONTEXT.md)
- Current implementation order and prerequisites:
  [`implementation/next.md`](implementation/next.md)
- Product relationships and permissions: [`product/model.md`](product/model.md)
- State transitions and customer-facing behavior:
  [`product/lifecycles.md`](product/lifecycles.md)
- Billing and capacity rules: [`product/billing.md`](product/billing.md)
- Inbox generation behavior: [`product/inbox-generation.md`](product/inbox-generation.md)

## Architecture

- System and module boundaries: [`architecture/system.md`](architecture/system.md)
- Public API rules: [`architecture/api.md`](architecture/api.md)
- Microsoft provisioner boundary: [`architecture/provisioner.md`](architecture/provisioner.md)
- Deployment and operations: [`architecture/operations.md`](architecture/operations.md)

## Decisions

Read an ADR before changing its decision:

- [`adr/0001-central-cloudflare-dns.md`](adr/0001-central-cloudflare-dns.md)
- [`adr/0002-public-api-key-authority.md`](adr/0002-public-api-key-authority.md)
- [`adr/0003-private-provisioner-boundary.md`](adr/0003-private-provisioner-boundary.md)
- [`adr/0004-scoped-read-write-access.md`](adr/0004-scoped-read-write-access.md)
- [`adr/0005-tenant-admin-credential-session.md`](adr/0005-tenant-admin-credential-session.md)

## Documentation Boundaries

- These are repository-internal engineering documents.
- `apps/fumadocs` is for customer-facing guides and the public API reference.
- The initial broad brief is archived at
  [`archive/engineer-handoff-initial.md`](archive/engineer-handoff-initial.md).
- Add a new ADR only for a hard-to-reverse choice with meaningful alternatives. Update
  the owning topical document for normal product and implementation decisions.
