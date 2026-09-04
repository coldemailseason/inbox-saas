# Product Lifecycles

Customer interfaces expose only `processing`, `completed`, and `failed`. Internal states
exist for correct orchestration, recovery, and support. These are lifecycle contracts for
planned product slices unless completion is recorded in the implementation roadmap.

## Tenant Connection

| Internal state      | Meaning                                                             | Customer status |
| ------------------- | ------------------------------------------------------------------- | --------------- |
| `validating`        | Credentials are being verified against Microsoft                    | `processing`    |
| `active`            | Microsoft tenant was validated and can be managed                   | `completed`     |
| `validation_failed` | Credentials or Microsoft validation failed                          | `failed`        |
| `detached`          | Removed from the platform; no credentials, sessions, or jobs remain | `completed`     |

- Creating a tenant reserves one slot and one credit, then starts validation.
- A failed tenant remains visible so its credentials can be updated and validation retried.
- Credentials cannot change while any tenant job is non-terminal.
- Updating credentials when no job is active invalidates the tenant's idle PowerShell
  session. The user explicitly starts any required retry.
- Validation uses write-only tenant-admin credentials to establish an ephemeral,
  tenant-scoped Microsoft session. Browser state, tokens, and session state are not
  persisted; a valid verified session may be reused until its 60-minute idle TTL. A
  successful authenticated health check or Microsoft action resets that idle timer.
- The provisioner holds reusable sessions only in an in-memory registry keyed by tenant
  connection ID. Each entry owns an isolated PowerShell process group and last-used time.
- Different tenant connections may run Microsoft work concurrently. One tenant connection
  permits one active Microsoft job, so its isolated session is never raced.
- A job remains customer-visible as `processing` while it internally waits for capacity,
  authenticates, reauthenticates, retries, or runs Microsoft work. Customers do not receive
  queue position or capacity-limit state.
- Unsupported Microsoft authentication challenges fail safely. They require a later
  explicit retry after compatible support exists; there is no manual or fallback flow.
- If validation discovers a tenant ID with another active organization owner, it fails
  without disclosing that organization.
- Detaching a tenant removes its credentials and session state. It may leave Microsoft
  resources and a detached SaaS-managed DNS zone intact.

## Domain

| Internal state  | Meaning                                                        | Customer status |
| --------------- | -------------------------------------------------------------- | --------------- |
| `setting_up`    | Records, delegation, or Microsoft verification are in progress | `processing`    |
| `awaiting_dns`  | Customer action or DNS propagation is required                 | `processing`    |
| `active`        | Domain is verified and configured                              | `completed`     |
| `setup_failed`  | Setup cannot proceed                                           | `failed`        |
| `deleting`      | Confirmed Microsoft-domain deletion is running                 | `processing`    |
| `deleted`       | Microsoft confirmed deletion; managed zone may be removed      | `completed`     |
| `delete_failed` | Cleanup requires recovery                                      | `failed`        |

- A tenant has one active domain. A new domain cannot be added until the current domain
  reaches `deleted`.
- `saas_managed_zone` creates a zone in the SaaS Cloudflare account and shows its
  nameservers for registrar delegation.
- `external_manual` returns the required Microsoft CNAME, MX, and TXT records only.
  It never includes SaaS Cloudflare SOA or NS records.
- Both modes capture the Microsoft-returned record values and require validation.
- Domain deletion is an explicit irreversible confirmation. It is allowed only after
  all inboxes under the tenant are deleted. The managed Cloudflare zone is deleted only
  after Microsoft confirms domain deletion.

## Inbox Plan And Inbox

| Inbox state           | Meaning                                                  |
| --------------------- | -------------------------------------------------------- |
| `generated`           | Present in an unconfirmed inbox plan                     |
| `queued_for_creation` | Confirmed and awaiting the creation job                  |
| `creating`            | Microsoft mailbox creation is in progress                |
| `created`             | Mailbox is active and its encrypted password exists      |
| `failed`              | Mailbox creation failed                                  |
| `queued_for_deletion` | Included in a confirmed deletion job                     |
| `deleting`            | Exchange deletion is in progress                         |
| `deleted`             | Mailbox is no longer active and its password was removed |
| `delete_failed`       | Deletion requires recovery                               |

- Plans are immutable once confirmed.
- The tenant-level 100 inbox limit is enforced transactionally, not in the UI.
- Partial creation success is represented per inbox.
- Standard Exchange Online deletion removes the associated user account and leaves the
  Microsoft mailbox soft-deleted during Microsoft's retention period. The platform does
  not separately call Graph user deletion or permanent directory purge in the MVP.

## Jobs

| Internal state | Meaning                                    | Customer status |
| -------------- | ------------------------------------------ | --------------- |
| `queued`       | Durable work exists but is not claimed     | `processing`    |
| `running`      | Worker owns an active lease                | `processing`    |
| `completed`    | Work finished successfully                 | `completed`     |
| `failed`       | Work reached a terminal failure            | `failed`        |
| `cancelled`    | Queued work was cancelled before execution | `failed`        |

- One tenant may have only one non-terminal Microsoft job.
- Queued jobs can be cancelled. Running jobs do not offer cancellation in the MVP.
- Every failure response has a stable safe failure code, retry eligibility, and allowed
  next action. Internal PowerShell and credential details remain out of public payloads.
