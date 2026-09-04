# ADR 0005: Write-Only Tenant Credentials and Ephemeral Microsoft Sessions

## Status

Accepted.

## Decision

Tenant-admin email/password credentials are stored encrypted at rest as write-only
authorization secrets. They are accepted only for authorized create or update and are
never returned to browser or public API clients. The API encrypts them and the worker
decrypts them just in time for an authenticated private provisioner request; plaintext
remains confined to that private execution boundary. Credentials automate an ephemeral
Zendriver browser sign-in and device-code completion, then establish a tenant-scoped
persistent PowerShell session in which Graph and Exchange authenticate together. Browser
profiles/cookies, tokens, device codes, and PowerShell session state are never persisted. A
verified session may be reused while valid, has a 60-minute idle TTL reset by authenticated
use, and is invalidated by credential updates.

## Considered Options

- Persisting browser state or Microsoft tokens was rejected because it expands the
  long-lived secret boundary.
- Manual device-code handoff was rejected because authentication is part of the private
  product workflow, not a customer-operated step.
- Fallback authentication models and custom Entra application-registration flows were
  rejected for the MVP to keep one auditable boundary.

## Consequences

- MFA, Conditional Access, CAPTCHA, risk prompts, and other unsupported challenges fail
  safely and require a later explicit retry after compatible support exists.
- There is one active Microsoft job per tenant connection, no cross-tenant session reuse,
  and different tenant connections may run concurrently within service admission limits.
- This records the credential and session boundary. The fake validation vertical exists;
  real provisioner execution remains planned.
