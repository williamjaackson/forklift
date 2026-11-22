# Forklift

> **Heavy lifting for your forks.**

Forklift is an intent-aware upstream sync engine for fast-moving open-source forks ("Renovate / Dependabot, but for entire forked repos").

Instead of blind line-by-line `git merge` conflicts or fragile patch queues, Forklift combines a declarative `forklift.yaml` manifest, deterministic guardrails, and agentic conflict resolution to open clean, verified **Sync PRs** automatically whenever upstream moves.

## Core Concepts

- **`forklift.yaml` Manifest** — Declares your upstream repo, sync cadence, owned paths (never overwritten), intentional hook points in upstream files, brand-leak rules, and verification commands.
- **Deterministic Guardrails** — Fast, non-LLM checks for leaked upstream branding, touchpoint drift tracking, lockfile regeneration, and disabled upstream CI workflows.
- **Intent-Aware Sync** — When upstream refactors a file you hook into, Forklift re-applies your documented intent rather than failing with raw conflict markers.
- **Automated Sync PRs** — Summarizes upstream changes, hooks lifted, brand leaks patched, and test results so maintaining a hard fork takes one quick PR review.

## First Live Testbed (Customer #0)

- Local Bonfire fork of `pingdotgg/t3code`: `/Users/williamjaackson/dev/bonfire`

## Branding

See [`BRAND.md`](./BRAND.md) and [`brand/forklift-brand.html`](./brand/forklift-brand.html) for the full visual identity, color tokens, and SVG assets.
