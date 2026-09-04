## Engineering Bias

- Prefer simple, robust, maintainable solutions with minimal necessary scope.
- Solve root causes, not symptoms.
- Quality, clarity, and long-term maintainability beat implementation speed.
- Make the smallest correct change that fully solves the problem: Occam's Razor.
- Do not over-engineer simple or obvious fixes.
- Minimize code impact, touch only what is necessary, and avoid introducing new bugs.
- Important: do not maintain fallbacks unless mentionned by the user. Ever.

## Code Style

- Fit existing architecture and patterns before inventing new ones.
- Prefer clear names, explicit control flow, and boring code over cleverness.
- Avoid dense one-liners, nested ternaries, unnecessary abstraction, broad rewrites, and obvious comments.
- Keep concerns separated.
- Do not collapse unrelated responsibilities into one function, component, module, or type just to reduce lines.
- Prefer code that is easy to read, debug, test, and extend.
- Add meaningful comments when it can make the code easier to understand in N months.

## Architectural Boundaries

- Keep Product behavior transport-neutral. The dashboard, public API, RPC, worker, and
  provisioner are clients of Product behavior; they do not own product rules.

## No Patch-On-Patch Shims

- This is a v0.0.1 MVP codebase. No point in maintaining rollbacks from v0.0.2 to v0.0.1. Just get it right the first time.
- Forward-only migrations; no downgrade or compatibility machinery.
- No adapters, fallbacks, or transitional layers for unshipped MVP behavior.
- Redesign the wrong abstraction rather than preserving it.
- Transaction rollback tests protect a single failed signup operation, not version rollback.
- Do not build patch-on-patch shims or preserve bad intermediate work.
- If an implementation direction changes, rework or replace the half-built piece so the final design is intentional.
- Do not stack adapters, flags, wrappers, compatibility layers, translation code, or special cases on top of a wrong abstraction just to keep it alive.
- Add shims only for real external compatibility boundaries, persisted data, migrations, or explicit requirements.
- Otherwise remove the wrong abstraction and implement the right one directly.
