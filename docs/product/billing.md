# Billing And Entitlements

## Rules

- Billing belongs to the organization, never a user or workspace.
- An active subscription grants platform access and active tenant slots.
- Onboarding credits are separate one-time purchases and never expire.
- All paid plans share the launch Microsoft-work policy: at most three active attempts per
  organization and five globally. Capacity waiting is internal durable-job state; customers
  continue to see `processing`.
- Every organization currently receives an internal unlimited entitlement through the
  Product entitlement path, never a user-ID bypass. It is not a standalone billing
  system.
- Billing, Polar integration, paid-plan mapping, and credit purchase flows remain
  deferred.

## Credit And Slot Lifecycle

1. Tenant-validation verifies organization authority and the internal unlimited
   entitlement before accepting work.
2. It atomically creates the tenant connection, job, idempotency record, and outbox
   event.
3. Paid slot and onboarding-credit reservations are deferred until real organization
   entitlements exist.

## Subscription Lapse

Organizations retain read access when a subscription becomes inactive. New mutations
and jobs are blocked. Queued jobs do not start until access resumes; a running Microsoft
operation is allowed to finish.

## Provider Boundary

When billing is implemented, Polar will report external billing facts. A local,
organization-level entitlement projection will be the authorization source. Webhook
processing must verify signatures, deduplicate provider event IDs, and update that
projection idempotently. Browser-visible subscription state is never an authorization
decision.
