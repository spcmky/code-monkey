# Code Monkey

Autonomous AI agent for GitHub issue monitoring, triage, implementation, and code review.

---

## How It Works

```
GitHub Issues/PRs
       |
       v
  Controller ──(polls)──> Watcher
       |
       v
  Decision Pyramid
  (Cache -> Rules -> Knowledge -> AI)
       |
       v
  Triage (Haiku) ── classifies + prioritizes
       |
       v
  Coder (Sonnet) ── implements on branch, runs tests, opens PR
       |
       v
  Reviewer (Sonnet) ── evaluates correctness, scope, security
       |                     |
       |               request_changes (max 3 cycles)
       |                     |
       v                     v
  Controller validates ── Coder reworks
       |
       +---> Merge    (approved + validated)
       +---> Escalate (confidence low, loop detected, policy violation)
       +---> Close    (duplicate, stale, wontfix)
```

## Design Principles

- **Adversarial Coder/Reviewer** -- The Coder and Reviewer are separate agents with different incentives. The Reviewer has no reason to rubber-stamp; it evaluates against explicit criteria and can reject or escalate.
- **Controller gates everything** -- No merge, comment, or label change happens without the Controller validating scope, grounding, and fact-checking the agent output.
- **Tiered model strategy** -- Haiku for cheap classification, Sonnet for coding and review, Opus reserved for complex edge cases. Titan for embeddings. Cost scales with task complexity.
- **Local knowledge layer** -- pgvector embeddings of files, issues, and past resolutions enable semantic search. A decision cache and rules engine handle repeat patterns without any LLM calls.

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 22, TypeScript (ESM) |
| AI Models | AWS Bedrock -- Claude Opus 4, Sonnet 4, Haiku 4.5, Titan Embed Text v2 |
| Database | PostgreSQL 16 + pgvector (1024-dim embeddings) |
| Messaging | SQS (task + result queues + DLQ), SNS (notifications) |
| Containers | Docker, ECS Fargate (Controller), ECS Fargate Spot (Agent Worker) |
| Infrastructure | OpenTofu (9 modules), KMS encryption, IAM least privilege |
| GitHub | Octokit REST client |
| Validation | Zod (config + message schemas) |
| Testing | Vitest |

---

## Quick Start

```bash
# Clone and configure
git clone <repo-url> code-monkey
cd code-monkey
cp .env.example .env
# Edit .env: set DB_PASSWORD, WATCHED_REPOS, GITHUB_PAT_SECRET_ARN

# Start all services
docker-compose up

# Optional: pgAdmin at http://127.0.0.1:5050
docker-compose --profile tools up
```

The Controller starts polling GitHub on a cron schedule (default: every 5 minutes). Migrations run automatically on first startup.

---

## Project Structure

```
code-monkey/
  src/
    index.ts                    # Controller entrypoint
    agent-worker.ts             # Agent worker entrypoint (SQS consumer)
    logger.ts                   # Winston logger
    types/index.ts              # Shared types, Zod schemas
    config/loader.ts            # Config loader with Zod validation
    controller/
      controller.ts             # Main orchestrator: poll, dispatch, validate
      state-machine.ts          # Issue state transitions + loop detection
      policy.ts                 # Policy enforcement
    agents/
      base-agent.ts             # Shared agent base class
      watcher.ts                # GitHub polling agent
      triage.ts                 # Issue classification agent
      coder.ts                  # Code implementation agent
      reviewer.ts               # PR review agent
      notifier.ts               # Notification agent
    knowledge/
      embeddings.ts             # pgvector embedding operations
      context-builder.ts        # Build agent context from knowledge layer
      repo-map.ts               # Repository structure analysis
      history.ts                # Past resolution lookup
    validation/
      scope.ts                  # Scope/path validation
      grounding.ts              # Bedrock grounding checks
      fact-check.ts             # Output fact verification
    tools/
      github.ts                 # Octokit GitHub operations
      git.ts                    # Git CLI operations
      bedrock.ts                # Bedrock API client
      testing.ts                # Test runner tool
    db/
      store.ts                  # Database access layer
      migrations.ts             # Migration runner
      migrations/
        001_initial_schema.sql  # Core tables + extensions
        002_embeddings.sql      # Vector embedding tables
        003_metrics.sql         # Daily metrics table
    utils/
      path-safety.ts            # Path traversal prevention
  config/
    policy.yaml                 # Scope, thresholds, escalation, rate limits
    agents.yaml                 # Per-agent model, tools, constraints
    rules.yaml                  # Deterministic routing rules
  tofu/                         # OpenTofu infrastructure (9 modules)
  Dockerfile.controller         # Controller container image
  Dockerfile.agent              # Agent worker container image
  docker-compose.yaml           # Local dev environment
  .env.example                  # Environment variable template
  tsconfig.json                 # TypeScript config (ES2022, NodeNext)
  package.json                  # Dependencies and scripts
```

---

## Configuration

- **`config/policy.yaml`** -- Scope control (allowed/escalate labels), protected paths, thresholds, escalation conditions, rate limits
- **`config/agents.yaml`** -- Per-agent model selection, temperature, token limits, tools, constraints
- **`config/rules.yaml`** -- Deterministic routing rules (evaluated top-to-bottom, first match wins, bypasses AI triage)
- **`.env`** -- Infrastructure config: database, AWS, SQS/SNS, Bedrock, GitHub

See [docs/configuration.md](docs/configuration.md) for the full reference.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components, decision pyramid, state machine, data flow, knowledge layer, security model, model strategy |
| [docs/deployment.md](docs/deployment.md) | Local dev setup, Docker Compose, AWS deployment with OpenTofu, environment variables reference |
| [docs/configuration.md](docs/configuration.md) | Policy, agents, rules, environment variables, config loader details |

---

## Development

```bash
npm install              # Install dependencies
npm run dev              # Controller with hot reload
npm run worker:dev       # Agent worker with hot reload
npm run test             # Run tests
npm run test:watch       # Tests in watch mode
npm run build            # Compile TypeScript
npm run lint             # ESLint
npm run format           # Prettier
```

---

## License

Proprietary. All rights reserved.
