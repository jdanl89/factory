# Software Factory

Autonomous, local-first product factory. Agents choose what to build, spec it, build it test-first,
review it, and package it for **you** to publish. You own `GOLDEN_RULES.md` and `approvals/`.

## Pipeline
`ideate â†’ compliance check â†’ plan â†’ build (TDD + review gate) â†’ release package â†’ human approval`

| Stage | Who (Ollama model) | Tool | Output |
|---|---|---|---|
| ideate | multi-lens research (paying demand, market gaps, non-developer pain, trends) scored by the analyst, then deep-read + needs analyst (verbatim, verified user quotes; npm/GitHub market check) â†’ strategist â†’ **fidelity reviewer** (must prove the idea solves what users asked, else revise/reject) â†’ compliance + regex denylist | â€“ | `ideas/<slug>.json` (includes `source_brief_detail` and `fidelity`) |
| architecture + plan | architect, then PM (configured Ollama models) | **OpenSpec** (`openspec/changes/<slug>`, validated) + **backlog.md** tasks | production proposal + spec + tasks |
| build | engineer + reviewer (configured Ollama models) | stack-specific quality gates, code guards | `products/<slug>` (own git repo), tasks â†’ Done |
| release | release writer | â€“ | README + `approvals/*-publish.md` |

## Architecture and supported engineering stacks
Every product receives a production-architecture proposal before planning. The architect compares plausible deployment models and services for the actual workload, including compute/runtime, API ingress, persistence, storage, identity/secrets, networking, observability, IaC, and checks-only CI. For relevant AWS APIs it considers Lambda + API Gateway, ECS/Fargate, Elastic Beanstalk, RDS, and DynamoDB rather than selecting services by habit. The chosen runtime and managed services determine the framework and language; the proposal and its assumptions are saved with the idea, OpenSpec change, and human approval request.

Supported profiles are React or Angular with TypeScript, Node.js with Express/Fastify/NestJS, ASP.NET Core on supported .NET, and Terraform or OpenTofu when infrastructure is in scope. Layers are selected by product need, not forced. The architecture is a proposal only: no cloud resource, account, paid service, deployment, or IaC apply is authorized by it.

## Quality gates and DevSecOps
The factory detects the product stack and runs its applicable local checks: tests, lint/format/type checks, frontend build and Playwright for browser apps, integration tests for services, npm/.NET dependency vulnerability checks, secret scanning, and IaC format/init/validate/security scans. Missing optional tools are recorded as skipped during task work; required release checks fail closed. npm, NuGet, and IaC lockfiles are required for reproducible release checks. A generated `.github/workflows/ci.yml` is checks-only with read-only repository permissions; existing workflows are not overwritten, but are checked against the stack's policy.

Release validation may require local `Semgrep` for SAST, `Trivy` for IaC security scans, and the matching `dotnet`, `terraform`, or `tofu` CLI for the product stack. Browser projects need Playwright and its Chromium browser installed. Install these tools through their official distribution channels; the factory does not install or run third-party tools on your behalf. CI can download its declared check tools, but never deploys, applies infrastructure, references secrets, or invokes paid services.

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
node factory/cli.mjs unblock <slug>                 # clear 'blocked' labels; next build resumes the task's existing subtasks
node factory/cli.mjs halt | resume                  # kill switch (creates/removes HALT)
node factory/cli.mjs models [test <role>]           # show role -> model chains, provider status, daily token use
npx backlog board        # kanban TUI      npx backlog browser   # web UI
npx openspec list        # spec changes
```
Logs: `factory/state/ledger.jsonl`.

## Frontier models (optional, human opt-in)
Any role in `factory.config.json` `models` can use a hosted model instead of (or before) a local one. A value is either a string or a fallback list tried in order:
```json
"engineerLarge": ["github:openai/gpt-4.1", "qwen3-coder:30b"],
"architect": "anthropic:claude-sonnet-4-5"
```
A `provider:` prefix selects an entry in `providers` (`github` = GitHub Models, `openai`, `anthropic`, `openrouter`; add any OpenAI-compatible endpoint with `type: "openai"`). Unprefixed names are local Ollama. Providers are **disabled by default**; to use one, (1) set `providers.<name>.enabled` to `true` (your written permission to spend), (2) set its key in an environment variable (`GITHUB_MODELS_TOKEN` with `models:read`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) before starting the factory, never in files, and (3) adjust `dailyTokenCap`. Once the cap is hit, or on any error, the factory falls through to the next entry in the role's list, so keep a local model last. Prompts (including product code) are sent to the provider. Run `node factory/cli.mjs models test <role>` to verify. GitHub Copilot subscriptions themselves have no API; GitHub Models is the supported GitHub route.

## Reuse over reinvention, and tool scouting
- Products use standard frameworks and libraries (see `platforms` and `dependencies.preferred` in `factory.config.json`), not custom auth/crypto/validation code. Principles live in `agents/_principles.md` and are injected into every agent prompt.
- For Node/TypeScript, engineers declare packages on a `DEPENDENCIES: a, b` line. The factory vets each one (registry lookup: license, deprecation, last release, weekly downloads, no install scripts/native builds), installs it with `--ignore-scripts`, rejects packages with high/critical `npm audit` findings, and rejects imports of undeclared packages. Agents never edit `package.json`.
- .NET package references and Terraform/OpenTofu providers must be versioned and locked; release gates run NuGet vulnerability checks and IaC provider validation/scanning. External service integrations remain inactive until the named service and spend are human-approved and configured.
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
- Hard denylist (gambling, dark patterns, malware, â€¦) runs in code on ideas and release copy, independent of any LLM.
- Compliance agent must approve every idea; anything needing money/accounts/publishing â†’ `approvals/`.
- File writes are sandboxed to `products/<slug>/` (no traversal, `.git`, `node_modules`, secrets).
- Generated product code that uses network/child_process/secret env vars is rejected.
- Agents cannot publish, deploy, or spend: no credentials exist in this system.
- `HALT` file stops everything; per-day cycle cap.

## Honest limits
- Local models and available hardware affect speed and task success; larger models may take substantially longer. The factory can split and rescope blocked work, but still records a blocker rather than claiming success if it cannot complete a check or task.
- Revenue needs you: creating a store/payment account, publishing, and support are human-only by rule 6.
  The factory prepares everything and lists exact steps in `approvals/`.
- **squad-cli** is installed (`npx squad`) but is a GitHub Copilotâ€“based multi-agent runtime; it isn't wired
  into the Ollama pipeline. Use it interactively if you want a Copilot-driven team on top of this repo.
