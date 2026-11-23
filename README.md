# Forklift

> **Heavy lifting for your forks.**

Forklift is an intent-aware upstream sync engine for fast-moving open-source forks ("Renovate / Dependabot, but for entire forked repos").

Instead of blind line-by-line `git merge` conflicts or fragile patch queues, Forklift combines a declarative `forklift.yaml` manifest, deterministic guardrails, and surgical AI conflict resolution to open clean, verified **Sync PRs** automatically whenever upstream moves.

## Architecture

```
packages/core   # Manifest/lockfile schema, path policy, 3-way git sync, guardrails, AI lift, PR reports
packages/cli    # `forklift` CLI (init, status, check, sync)
action.yml      # Reusable GitHub Action (PR guardrails + automated Sync PRs)
examples/       # Sample forklift.yaml & GitHub Actions workflow
```

## Quickstart

```bash
pnpm install
pnpm build

# 1. Initialize in your fork (auto-detects `upstream` remote & lockfiles)
node packages/cli/dist/bin.js init -C /path/to/your-fork

# 2. Run deterministic guardrails (brand leaks, touchpoint drift, dropped paths)
node packages/cli/dist/bin.js check -C /path/to/your-fork

# 3. Preview incoming upstream changes & affected hooks
node packages/cli/dist/bin.js status -C /path/to/your-fork

# 4. Lift upstream commits & open a Sync PR
node packages/cli/dist/bin.js sync --pr -C /path/to/your-fork
```

## GitHub Action Bot

Drop [`examples/github-workflow.yml`](./examples/github-workflow.yml) into `.github/workflows/forklift.yml` in your forked repo and add `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) to GitHub Secrets:

- **On every PR:** runs `forklift check` to catch brand leaks, resurrected dropped workflows, and undeclared upstream edits.
- **On schedule / manual dispatch:** runs `forklift sync --pr` to lift new upstream commits, run your verify gates, and open/update a structured Sync PR.

## AI Runners

Forklift handles ~90% of a sync deterministically (0 LLM calls) and invokes AI only for conflicting hooks, refactored anchors, or failing `agent_fix` verification gates. Auto-detected in order (override with `--ai` or `FORKLIFT_AI`):

1. `ANTHROPIC_API_KEY` → Anthropic Messages API (`anthropic`)
2. `OPENAI_API_KEY` → OpenAI Chat Completions API (`openai`)
3. Local `claude` CLI (`claude`)
4. Local `codex` CLI (`codex`)

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
```

## First Live Testbed (Customer #0)

- Local Bonfire fork of `pingdotgg/t3code`: `/Users/williamjaackson/dev/bonfire` (see [`examples/forklift.bonfire.yaml`](./examples/forklift.bonfire.yaml))

## Branding

See [`BRAND.md`](./BRAND.md) and [`brand/forklift-brand.html`](./brand/forklift-brand.html) for the full visual identity, color tokens, and SVG assets.
