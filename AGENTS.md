# Project

This project provides a TypeScript CLI for acquiring and working with Colombian lending-interest-rate data. Use Node.js 24 or newer and manage the pnpm monorepo with `pnpm`. The CLI lives in `apps/cli`.

# Design

Keep responsibilities explicit and dependencies directional. CLI modules handle user and process concerns, command modules coordinate workflows, Socrata modules handle remote communication, and storage modules handle durable local state. Prefer small, cohesive components over generic utility modules or speculative abstractions.

Use immutable values where state crosses boundaries, and make transformations explicit through return values. Keep asynchronous workflows cancellation-safe and ensure interrupted operations leave durable state consistent.

# Data

Treat the raw layout and manifest format as public contracts because downstream tools may depend on them. Preserve source provenance and avoid silent data loss, ambiguous source selection, or partially committed files. Changes to paths, partition identity, or manifest fields require migration and compatibility consideration.

# Testing

Test behavior through agreed public seams. Command tests should use lightweight boundary implementations, remote-client tests should use a local HTTP server, and storage tests should use temporary directories. Do not call external services from the automated suite or couple tests to private implementation details.

Work in small test-driven slices when changing behavior. Keep important data-integrity, concurrency, cancellation, and compatibility scenarios covered.

# Domain language and CONTEXT.md

Read the root `CONTEXT.md` when discussing or changing domain terminology. Use its Spanish terms consistently in code, data descriptions, and user-facing copy. If a proposed term conflicts with the glossary, point out the difference; clarify ambiguous terms with concrete examples and check claims against the source data and code.

Update `CONTEXT.md` as soon as a domain term is resolved. Keep it a glossary, not a specification or an implementation log: a short context description followed by `## Language` or natural topic headings, with each entry formatted as `**Término**:`, a one- or two-sentence definition of what it is, and `_Evitar_:` for misleading alternatives. Define only project-specific concepts, prefer one canonical term per concept, and distinguish verified facts from interpretations. Do not add storage paths, implementation details, or unverified expansions of source codes.

## Code Structure

Write each file so it can be read from overview to detail. Follow the language’s conventions. Put shared constants and types near the top. Show the public API and its orchestration before the private functions that support them. Place new code where it fits this flow and improve the code you touch rather than carry obsolete patterns forward.

Keep related statements together. Use blank lines to separate independent steps, including when a new step follows a control-flow block. When a block returns control or signals an error after other work, leave a blank line before that step.

Require collaborators explicitly and provide them at the composition root. Do not use optional dependencies with fallback implementations.

# Quality

Use clear project vocabulary and conventional TypeScript structure. Add dependencies only when they materially simplify the design. Keep documentation focused on the supported user surface rather than internal implementation details.

Before finishing, run `pnpm format`, `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check`.

# CLI

Pull data with `node apps/cli/dist/cli.js pull` after `pnpm build`. Preserve concise structured stderr output so long-running commands remain observable to people and automation.
