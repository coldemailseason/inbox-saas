# ADR 0003: Private Tenant-Scoped Provisioner

## Status

Accepted.

## Decision

Microsoft execution runs in a private Python provisioner called only by the TypeScript
worker. It exposes versioned high-level workflow requests, not arbitrary PowerShell
execution. It owns one PowerShell session/process group per tenant connection and never
reuses a process across tenants.

## Consequences

- Public API and web layers never receive Microsoft execution privileges.
- Product state, billing, authorization, job creation, and retries remain in the
  TypeScript control plane.
- The provisioner handles device-code prerequisites, PowerShell session lifecycle, and
  short Microsoft/DNS polling.
- A worker authenticated request and private Docker network protect the provisioner;
  public ports are not published.
