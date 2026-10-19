# Software Factory

Autonomous, local-first product factory. Agents choose what to build, spec it, build it test-first,
review it, and package it for **you** to publish. You own `GOLDEN_RULES.md` and `approvals/`.

## Pipeline
`ideate → compliance check → plan → build (TDD + review gate) → release package → human approval`

| Stage | Who (Ollama model) | Tool | Output |
|---|---|---|---|
| ideate | strategist (qwen3:8b) + compliance (qwen3:8b) + regex denylist | – | `ideas/<slug>.json` |
| plan | pm (qwen3:8b) | **OpenSpec** (`openspec/changes/<slug>`, validated) + **backlog.md** tasks | spec + tasks |
| build | engineer (qwen2.5-coder:14b), reviewer (qwen3:8b) | `node --test` gate, code guard | `products/<slug>` (own git repo), tasks → Done |
| release | release writer | – | README + `approvals/*-publish.md` |

Process discipline from **obra/superpowers** is vendored in `vendor/superpowers` (TDD, verification-before-completion,
systematic-debugging, writing-plans, code review skills). The personas in `agents/` encode the same principles
(test-first, verify before claiming done, review gate). Point any Claude Code/Copilot session at those skills when *you* work in this repo.

## Commands
```
node factory/cli.mjs cycle ["optional idea hint"]   # full pipeline once
node factory/cli.mjs loop                           # continuous, capped per day (factory.config.json)
node factory/cli.mjs ideate|plan <slug>|build <slug>|release <slug>
node factory/cli.mjs status
node factory/cli.mjs research                       # fetch public demand signals (cached 12h)
node factory/cli.mjs approve <slug> [--note "constraint"]...   # accept an idea compliance rejected / add human constraints
node factory/cli.mjs reject <slug>
node factory/cli.mjs scrap <slug> [--yes]           # delete everything for an idea/product (dry-run without --yes)
node factory/cli.mjs halt | resume                  # kill switch (creates/removes HALT)
npx backlog board        # kanban TUI      npx backlog browser   # web UI
npx openspec list        # spec changes
```
Logs: `factory/state/ledger.jsonl`.

## Reuse over reinvention, and tool scouting
- Products are built on standard npm packages (express, zod, bcryptjs, jose, helmet, openid-client, ... see `dependencies.preferred` in `factory.config.json`), not custom auth/crypto/validation code. Principles live in `agents/_principles.md` and are injected into every agent prompt.
- Engineers declare packages on a `DEPENDENCIES: a, b` line. The factory vets each one (registry lookup: license, deprecation, last release, weekly downloads, no install scripts/native builds), installs it with `--ignore-scripts`, rejects packages with high/critical `npm audit` findings, and rejects imports of undeclared packages. Agents never edit `package.json`.
- Reviewer fails hand-rolled security code; evaluator reports `reinvented_wheels`; iteration planner schedules replacing them first.
- `node factory/cli.mjs scout` (also runs weekly inside `cycle`) searches the MCP registry, npm and GitHub for MCP servers/skills/tools and writes `tooling/catalog.json`. `tools` lists it; `tools-approve <id>` / `tools-reject <id>` decide. Approved skills (markdown, scanned, <20KB) are injected into the chosen roles' prompts (`skills/approved/`); approved MCP servers are listed in `tooling/approved-for-human-install.md` for you to add to your own Copilot/Claude setup (the factory orchestrator does not run MCP servers).

## Self-iteration (evaluate -> plan next increment -> build -> repeat)
After the initial build is done, each iteration: mechanical checks (tests + boot/smoke test) + LLM evaluation -> next-increment plan
(compliance-checked, max `iterate.maxTasksPerIteration` tasks) -> build -> changelog + git tag `iter-N`. Artifacts: `iterations/<slug>/iter-N/`.
```
# 1. Manual: you trigger each iteration (or a bounded run)
node factory/cli.mjs iterate <slug> [--count 3]
# 2. Plan only: evaluate + plan, then wait for you (edit iterations/<slug>/iter-N/plan.json if you like)
node factory/cli.mjs iterate <slug> --plan-only
node factory/cli.mjs iterate-approve <slug> [--note "constraint"] [--auto]
node factory/cli.mjs iterate-reject <slug> --note "feedback"    # re-plans with your feedback
# 3. Fully automatic loop
node factory/cli.mjs iterate <slug> --auto [--max 10]
node factory/cli.mjs iterate-stop <slug|all>        # stop after the current iteration
node factory/cli.mjs iterate-stop <slug|all> --now  # stop at the next checkpoint (resumable; partial work is stashed)
```
`cycle`/`loop` can chain this automatically: set `iterate.afterRelease` in `factory.config.json` to `manual` (default), `plan` or `auto`.
Auto mode stops itself when the planner judges the product converged, after 2 consecutive iterations with blocked tasks, or at `maxIterations`.
Requires the initial build to be finished (no open non-iteration tasks).

## How the golden rules are enforced (not just requested)
- Rules are injected into every agent prompt.
- Hard denylist (gambling, dark patterns, malware, …) runs in code on ideas and release copy, independent of any LLM.
- Compliance agent must approve every idea; anything needing money/accounts/publishing → `approvals/`.
- File writes are sandboxed to `products/<slug>/` (no traversal, `.git`, `node_modules`, secrets).
- Generated product code that uses network/child_process/secret env vars is rejected.
- Agents cannot publish, deploy, or spend: no credentials exist in this system.
- `HALT` file stops everything; per-day cycle cap.

## Honest limits
- 7–14B local models on a 6 GB GTX 1060 build small, simple tools; expect some tasks to end up `blocked`
  (see `approvals/*-blocked-task.md`). Improve by changing `models.engineer` in `factory.config.json`
  (e.g. to a larger/hosted model, which is a spend decision needing your approval).
- Revenue needs you: creating a store/payment account, publishing, and support are human-only by rule 6.
  The factory prepares everything and lists exact steps in `approvals/`.
- **squad-cli** is installed (`npx squad`) but is a GitHub Copilot–based multi-agent runtime; it isn't wired
  into the Ollama pipeline. Use it interactively if you want a Copilot-driven team on top of this repo.
