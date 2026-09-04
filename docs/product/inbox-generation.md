# Inbox Generation

Inbox generation is a product capability, not a Python provisioner concern.

## Workflow

```text
generate plan -> inspect exact inboxes -> confirm plan -> create-inboxes job
```

The confirmed plan is immutable. The worker and provisioner receive that snapshot and
must never regenerate names, local-parts, or passwords during a retry.

## Modes

### Random

Inputs are:

- `inboxCount` from 1 to 100, subject to existing inboxes on the tenant
- `identityCount`
- locale: US, French, or Spanish
- gender: male, female, or random

The generator selects identities and distributes the requested inbox count across them.

### Specific

Inputs are first/last-name pairs and `inboxCount`. The same pattern system creates the
requested number of unique addresses from those identities.

## Address Rules

- Generate local-parts against the tenant's single active domain.
- Apply professional predefined patterns in priority order.
- Add numeric suffixes only after non-numeric patterns are exhausted.
- Enforce uniqueness within the planned batch and against non-deleted platform inboxes.
- Persist the chosen identity, pattern, and local-part with the plan so retries are
  deterministic.

## Passwords

The platform generates one strong password per inbox. It stores passwords encrypted at
rest, removes them when the inbox deletion completes, and exposes them only to
authorized UI/API callers. A later CSV export streams authorized plaintext passwords;
plaintext passwords are never stored in the database or logs.

## Deferred Work

The exact preview-editing UI, CSV format, name-data source and licensing, pattern
catalog, and password policy remain implementation decisions. The historical archive
at `legacy-reference/inbox-generator-prototype.py` may inform only the ordering of
local-part patterns. Its browser automation, Microsoft authentication or session
handling, PowerShell execution, credentials, passwords, CSV output, identity data,
CLI or configuration, and DNS zone contents are prohibited reference. Canonical
product documentation governs all future implementation.
