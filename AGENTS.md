# Project

This project provides a Python CLI for acquiring and working with Colombian lending-interest-rate data. Use Python 3.13 or newer and manage dependencies and commands with `uv`.

# Design

Keep responsibilities explicit and dependencies directional. CLI modules handle user and process concerns, command modules coordinate workflows, Socrata modules handle remote communication, and storage modules handle durable local state. Prefer small, cohesive components over generic utility modules or speculative abstractions.

Use immutable values where state crosses boundaries, and make transformations explicit through return values. Keep asynchronous workflows cancellation-safe and ensure interrupted operations leave durable state consistent.

# Data

Treat the raw layout and manifest format as public contracts because downstream tools may depend on them. Preserve source provenance and avoid silent data loss, ambiguous source selection, or partially committed files. Changes to paths, partition identity, or manifest fields require migration and compatibility consideration.

# Testing

Test behavior through agreed public seams. Command tests should use lightweight boundary implementations, remote-client tests should use a local HTTP server, and storage tests should use temporary directories. Do not call external services from the automated suite or couple tests to private implementation details.

Work in small test-driven slices when changing behavior. Keep important data-integrity, concurrency, cancellation, and compatibility scenarios covered.

# Quality

Use clear project vocabulary and conventional Python structure. Add dependencies only when they materially simplify the design. Keep documentation focused on the supported user surface rather than internal implementation details.

Before finishing, run `uv format`, `uv run ruff check .`, `uv run pytest`, `git diff --check`, and compile the source tree.

# CLI

Pull data with `uv run lending-interest-rates pull`. Preserve concise structured stderr output so long-running commands remain observable to people and automation.
