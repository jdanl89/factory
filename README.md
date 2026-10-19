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
node factory/cli.mjs halt | resume                  # kill switch (creates/removes HALT)
npx backlog board        # kanban TUI      npx backlog browser   # web UI
npx openspec list        # spec changes
```
Logs: `factory/state/ledger.jsonl`.

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
