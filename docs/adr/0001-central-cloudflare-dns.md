# ADR 0001: Central SaaS-Owned Cloudflare Zones

## Status

Accepted.

## Decision

The SaaS owns one central Cloudflare account. For `saas_managed_zone` domains it creates
one zone per customer domain, writes only Microsoft mail records, and returns the
assigned nameservers for the customer to configure at their registrar.

Customers may instead choose `external_manual`, where the platform supplies the exact
Microsoft records and validates public DNS without controlling the zone.

## Consequences

- Managed DNS gives turnkey record creation and polling without requesting a customer's
  Cloudflare credentials.
- The platform manages only Microsoft mail records, not general-purpose customer DNS.
- A detached tenant can leave a managed zone in place so existing Microsoft mail keeps
  working. That zone is read-only until explicit DNS migration or domain deletion.
- External-manual exports contain required CNAME, MX, and TXT records only. They never
  include the SaaS Cloudflare SOA or nameserver records.
