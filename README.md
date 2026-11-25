# Forklift

> **Heavy lifting for your forks.**

Forklift keeps a fork up to date with a fast-moving upstream. It merges upstream into the fork on a schedule, settles the predictable conflicts by rule, hands the rest to the coding agent you already use, runs your checks, and then either lands the merge or opens a pull request that shows only what needs a human eye.

It is a command-line tool, not a service. It keeps no database and runs no server: everything it knows is in git and in the pull request. Run it from cron, in containers, or as a scheduled GitHub Action.

## How a sync works

A sync has two halves, and they can run in different places.

**Build** merges and tests. It needs no credentials that can push.

1. **Merge with git.** A real `git merge` of upstream, in a workspace of Forklift's own. Your checkout is never touched, and git's history records how far the fork has synced.
2. **Settle the boring conflicts by rule.** Paths you dropped stay deleted, files you own keep your version, lockfiles are regenerated.
3. **Hand the rest to an agent.** `claude`, `codex`, or any command that reads a task on stdin. It gets the conflicted files, both sides' commit history, and your notes about what the fork must keep.
4. **Run your checks.** If a `verify` command fails, the agent gets the output and one more go.

**Publish** decides what becomes of the build. It holds the credentials, and runs no code from the fork or from upstream.

5. **Check the result against the rules again,** from git's objects alone, and work out whether anything in it was a judgement call: any file that is not what `git merge` produces and that no rule accounts for.
6. **Land or ask.** A merge nobody had to think about is pushed. A merge with a judgement call in it becomes a pull request whose body shows only those files, not the whole upstream diff. A merge with a failing check becomes a draft. A build that breaks a rule is not published at all.
7. **If the build could not finish,** Forklift bisects upstream's history, lands every commit before the first one that conflicts, and opens an issue naming that commit.

`forklift sync` does both halves in one process. `forklift build` and `forklift publish` do one each, with a single file passed between them.

## Quick start

```bash
pnpm install && pnpm bundle          # builds dist/forklift.cjs
alias forklift="node $PWD/dist/forklift.cjs"

cd /path/to/your-fork
forklift init --upstream owner/project   # writes forklift.yaml from what the fork already does
git add forklift.yaml && git commit -m "Add forklift.yaml" && git push

forklift status            # how far behind, what would conflict, which upstream commit causes it
forklift sync --dry-run    # build the merge locally; push nothing
forklift sync              # do it
```

Needs git 2.38 or newer, Node 20 or newer, and the [GitHub CLI](https://cli.github.com) for pull requests and issues.

## forklift.yaml

Only `upstream` is required. [`examples/forklift.yaml`](./examples/forklift.yaml) has every option with comments.

```yaml
upstream: pingdotgg/t3code

drop:                       # must not exist in this fork
  - .github/workflows/**
ours:                       # this fork's version always wins
  - README.md
regenerate:                 # rebuilt, not merged
  pnpm-lock.yaml: pnpm install --lockfile-only
forbid:                     # text upstream must not bring in
  - { pattern: 'T3 Code', in: 'apps/**', replace: Bonfire }
verify:                     # must pass before a merge lands
  - pnpm install --frozen-lockfile
  - pnpm tc
agent: claude               # resolves what the rules cannot
notes: |                    # what the agent should know about this fork
  Bonfire is a rebrand of T3 Code. User-visible names say "Bonfire".
```

The file is read from the branch being synced, so the rules travel with the fork.

## Commands

| Command | What it does |
|---|---|
| `forklift init` | Writes a starter `forklift.yaml`: finds paths the fork deleted, lockfiles, and an installed agent. |
| `forklift status` | Shows how far behind the fork is, what a sync would hit, the first upstream commit that conflicts, and which of the fork's files upstream changes most. Touches nothing. |
| `forklift sync` | Runs one sync, both halves. `--dry-run` pushes nothing, `--pr` always opens a pull request, `--no-agent` skips the agent, `--retry` ignores the back-off. |
| `forklift build --out FILE` | The first half: builds the merge and writes it to a file. |
| `forklift publish FILE` | The second half: checks a build and pushes it or opens a pull request. |
| `forklift check` | Checks the files on disk against `forbid` and `drop`. For the fork's own pull requests. |
| `forklift watch` | Syncs one or more forks on a timer. `--role build` and `--role publish` run one half each. This is what the containers run. |

`sync` and `publish` exit 0 when there is nothing a person must do, 2 when a merge needs review, 3 when it is blocked on a conflict, and 4 when a build was rejected for breaking a rule.

## Running it

**On your own machine,** where `git push` and your agent already work: `forklift sync`, by hand or from cron.

**In containers** (any machine with Docker or Podman), one for each half:

```bash
cp deploy/forklift.env.example forklift.env    # forks, agent credentials, GitHub App or token
docker compose -f deploy/compose.yaml --env-file forklift.env up -d
```

The image is built by [`.github/workflows/image.yml`](./.github/workflows/image.yml) and published to `ghcr.io/williamjaackson/forklift`.

**As a scheduled GitHub Action** in the fork, with no server at all: copy [`examples/github-workflow.yml`](./examples/github-workflow.yml). It runs the two halves as two jobs.

## Acting as a bot

By default Forklift's merge commits are authored by `forklift[bot]`, and its pull requests are opened by whoever owns the token it was given. To have pull requests come from a bot as well, give it a GitHub App of your own:

1. Create the App. This link fills in the form: [github.com/settings/apps/new](https://github.com/settings/apps/new?name=forklift-YOURNAME&url=https://github.com/williamjaackson/forklift&public=false&webhook_active=false&contents=write&pull_requests=write&issues=write). Change the name (it must be unique on GitHub; the bot is named after it), and create it. It asks for read/write on Contents, Pull requests and Issues. Leave **Workflows** off unless your fork takes upstream's workflow files: without it, GitHub itself refuses any push that changes what your Actions run.
2. On the App's page, note the **App ID** and generate a **private key**.
3. Install the App on your fork, and only on your fork.
4. Give the publishing half `FORKLIFT_APP_ID` and `FORKLIFT_APP_PRIVATE_KEY` (the key file's contents, or its path in `FORKLIFT_APP_PRIVATE_KEY_FILE`).

Forklift then asks GitHub for a token that works only on that fork and expires within the hour, each time it publishes. Pull requests opened by an App also start your other workflows, which ones opened by GitHub's default Actions token do not.

Without an App, use a fine-grained token limited to the fork, with the same permissions.

If your fork does take upstream's workflow files, remember what that means: upstream decides what runs in your Actions, with your secrets. Most forks should list `.github/workflows/**` under `drop`.

## What Forklift trusts, and what it does not

Upstream's code is input nobody on the fork has reviewed. The agent reads it, and your `regenerate` and `verify` commands run it. Forklift is built so that this code gets as little as possible, and so that being wrong about it costs as little as possible.

What holds in every setup:

- The agent and your commands run in a workspace that is a repository of its own. Every git command Forklift runs there is run without credentials, so a git setting planted there never executes with a token.
- After each of those steps the workspace is put back under the fork's rules. A check cannot change the merge, a `regenerate` command can change the files it regenerates and nothing else, and nothing can bring back a dropped path, alter a file the fork owns, or edit `forklift.yaml`.
- The publishing half takes the merged tree and nothing else on trust, and then checks the tree too. It makes the merge commit itself, and decides for itself whether the merge needs review.
- The built-in `claude` and `codex` commands may edit files and read git history, and nothing else.

What depends on how you run it:

- **One process (`forklift sync`).** The agent and your commands run as the same user as Forklift, which holds the credentials for pushing. Forklift keeps those credentials out of their environment, which stops a token being handed over, logged, or picked up by a tool that looks for one. It does not stop a program that sets out to find that user's credentials: on the same machine, as the same user, it can. This is the same exposure as running upstream's build on your own machine in the first place.
- **Two places (`build` and `publish`).** The half that runs upstream's code has no credentials that can push, and the half that has them runs none of that code. This is the setup to use on a server or in CI, and both the compose file and the Actions example are written this way.

In both, the agent's own credentials are within reach of your `verify` and `regenerate` commands, because the agent has to run where they do. Use an agent credential you can cap or revoke.

One thing the publisher cannot check is whether your `verify` commands really passed: it takes the build's word. The worst a lying build can do with that is get a merge that is exactly git's own merge of upstream, plus your rules, landed without its tests having passed.

**Merge Forklift's pull requests with "Create a merge commit".** Squashing or rebasing one cuts the fork off from upstream's history, and every later sync would conflict.

## Development

```bash
pnpm build       # compile both packages
pnpm test        # runs real merges against throwaway repositories
pnpm typecheck
pnpm bundle      # dist/forklift.cjs, a single file
```

```
packages/core   build (merge, rules, agent, checks) and publish (inspect, land, report)
packages/cli    the `forklift` command
deploy/         container entrypoint and compose file
action.yml      GitHub Action wrapper
```

## Branding

See [`BRAND.md`](./BRAND.md) and [`brand/forklift-brand.html`](./brand/forklift-brand.html).
