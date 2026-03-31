# Architecture

Detailed architecture documentation for Code Monkey.

---

## System Components

| Component | Role | Runtime |
|---|---|---|
| **Controller** | Polls GitHub, dispatches tasks via SQS, validates agent outputs, manages state machine, gates all merges | Long-running ECS service (FARGATE) |
| **Watcher** | Monitors GitHub repos for new/updated issues, PRs, and comments | Invoked by Controller on cron |
| **Triage Agent** | Classifies issues by type and priority, assigns to appropriate pipeline | SQS-driven agent worker |
| **Coder Agent** | Implements fixes/features on a branch, runs tests, opens PRs | SQS-driven agent worker |
| **Reviewer Agent** | Reviews PRs against correctness, scope, tests, style, security, performance criteria | SQS-driven agent worker |
| **Notifier** | Sends escalation alerts, merge summaries, failure notices via SNS | SQS-driven agent worker |
| **Agent Worker** | Generic SQS consumer that picks up task messages and dispatches to the correct agent | Long-running ECS service (FARGATE_SPOT) |

---

## Decision Pyramid

Incoming issues are routed through a four-tier decision pyramid. Each tier is cheaper and faster than the one below it. The system exits as soon as a tier produces a decision.

```
+---------------------------------------+
|  1. Decision Cache                    |  Instant lookup by cache_key
|     (cached triage from past issues)  |  TTL-based expiry
+---------------------------------------+
|  2. Rules Engine                      |  Deterministic pattern matching
|     (config/rules.yaml)              |  First-match, top-to-bottom
+---------------------------------------+
|  3. Local Knowledge Layer             |  pgvector similarity search
|     (embeddings: file, issue,        |  against past resolutions
|      resolution)                      |
+---------------------------------------+
|  4. AI Triage (Haiku)                 |  Full LLM classification
|     (Claude Haiku via Bedrock)        |  Only when tiers 1-3 miss
+---------------------------------------+
```

**When each tier is used:**

- **Cache** -- Identical or near-identical issues that were previously triaged. Keyed by a hash of title + labels + body excerpt. Cheapest path (zero LLM calls).
- **Rules Engine** -- Deterministic patterns defined in `config/rules.yaml`. Dependency bumps, typos, security keywords, stale issues, and known question patterns all match here. Bypasses AI entirely.
- **Local Knowledge** -- Semantic search over past resolutions, file content, and issue embeddings stored in pgvector. If a sufficiently similar past resolution exists (cosine similarity >= 0.7), the system reuses the approach.
- **AI Triage** -- Fallback when nothing above matches. Claude Haiku classifies the issue type, priority, and suggested approach. Cheapest Claude model, used only when necessary.

---

## State Machine

Every tracked issue moves through a state machine. Transitions are validated at the code level and recorded in the `state_transitions` table.

```
                          +----------+
                          | DETECTED |
                          +----+-----+
                               |
                          triage_complete
                               |
                          +----v-----+
                     +--->| TRIAGED  |---+
                     |    +----+-----+   |
                     |         |         | close
                     |      assigned     |
                     |         |         v
                     |    +----v-----+  +--------+
                     |    | ASSIGNED |  | CLOSED |
                     |    +----+-----+  +--------+
                     |         |
                     |     work_started
                     |         |
            +--------+    +----v-------+
            |ESCALATED|<--| IN_PROGRESS|<-----+
            +----+----+   +----+-------+      |
                 |              |              |
            human reassign   impl_complete    | review_changes_requested
                 |              |              | (max 3 cycles)
                 v         +----v-------+     |
            +--------+    | IMPLEMENTED |     |
            | ASSIGNED|   +----+--------+     |
            +--------+        |               |
                          review_started      |
                               |              |
                         +-----v-------+      |
                         | UNDER_REVIEW +-----+
                         +-----+-------+
                               |
                         review_approved
                               |
                         +-----v-----+
                         | VALIDATED  |
                         +-----+-----+
                               |
                            merged
                               |
                         +-----v-----+
                         |  MERGED   |
                         +-----+-----+
                               |
                            closed
                               |
                         +-----v-----+
                         |  CLOSED   |
                         +-----------+
```

**Loop detection:** The state machine tracks `IN_PROGRESS <-> UNDER_REVIEW` cycles per issue. After **3 round-trips** (reviewer requests changes 3 times), the system forces an `ESCALATED` transition instead of looping back to `IN_PROGRESS`. This prevents infinite rework between the Coder and Reviewer agents.

**Valid transitions:**

| From | Allowed Next States |
|---|---|
| DETECTED | TRIAGED, ESCALATED |
| TRIAGED | ASSIGNED, ESCALATED, CLOSED |
| ASSIGNED | IN_PROGRESS, ESCALATED |
| IN_PROGRESS | IMPLEMENTED, ESCALATED |
| IMPLEMENTED | UNDER_REVIEW, ESCALATED |
| UNDER_REVIEW | VALIDATED, IN_PROGRESS, ESCALATED |
| VALIDATED | MERGED, ESCALATED |
| MERGED | CLOSED |
| ESCALATED | ASSIGNED, CLOSED |
| CLOSED | (terminal) |

---

## Data Flow

```
GitHub (Issues/PRs/Comments)
    |
    v
Watcher (polls on cron)
    |
    v
Controller (state machine + decision pyramid)
    |
    v
SQS Task Queue ──────────────> Agent Worker
    (code-monkey-tasks)              |
                                     |  dispatches to:
                              +------+------+------+
                              |      |      |      |
                           Triage  Coder  Reviewer  Notifier
                              |      |      |      |
                              +------+------+------+
                                     |
                                     v
                            SQS Result Queue
                           (code-monkey-results)
                                     |
                                     v
                            Controller validates
                              |            |
                        pass  |            | fail / escalate
                              v            v
                           GitHub       SNS Notification
                        (merge/comment) (escalation alert)
```

**Message format:** Task messages are JSON payloads validated with Zod schemas at both send and receive. Each message includes the full `AgentContext`: the issue, relevant files, similar past issues, repo profile, and the active policy config.

**Dead letter queue:** Failed messages (after SQS retry exhaustion) land in a DLQ. The monitoring module has a CloudWatch alarm on DLQ depth.

---

## Knowledge Layer

The knowledge layer uses **pgvector** with 1024-dimensional embeddings from **Amazon Titan Embed Text v2**.

### Embedding Tables

| Table | Content | Dimensions | Index Type |
|---|---|---|---|
| `file_embeddings` | Chunked source file content per repo | vector(1024) | IVFFlat (cosine, lists=100) |
| `issue_embeddings` | Issue title + body per repo | vector(1024) | IVFFlat (cosine, lists=100) |
| `resolution_embeddings` | Resolution summaries + approach from past fixes | vector(1024) | IVFFlat (cosine, lists=100) |

### Decision Cache

The `decision_cache` table stores past triage decisions keyed by a hash of the issue content. Entries have a TTL (`expires_at`) and a `hit_count` for tracking reuse. When a cache hit occurs, the system skips AI triage entirely.

### Similarity Thresholds

- **Confidence threshold:** 0.7 -- below this, the system escalates rather than acting autonomously
- **Grounding threshold:** 0.7 -- Bedrock guardrail contextual grounding check
- **Relevance threshold:** 0.7 -- Bedrock guardrail relevance check

---

## Database Schema Overview

All tables live in a single PostgreSQL 16 database with the `pgvector` and `uuid-ossp` extensions.

### Core Tables

| Table | Purpose | Key Details |
|---|---|---|
| `issues` | Tracked GitHub issues and processing state | Soft delete via `deleted_at`, partial indexes on active rows, CHECK constraints on state/priority/confidence |
| `state_transitions` | Audit trail for every state change | `ON DELETE RESTRICT` -- transitions are never lost |
| `agent_actions` | Log of all agent operations | Token counts, cost estimates, duration tracking. `ON DELETE SET NULL` preserves history |
| `decision_cache` | Cached triage decisions | TTL via `expires_at`, hit counter, keyed by `cache_key` |
| `audit_log` | Immutable system-wide audit trail | Triggers prevent UPDATE and DELETE. BIGSERIAL PK for append-only writes |
| `repo_profiles` | Cached repository metadata | Language, framework, test/build/lint commands |

### Embedding Tables

| Table | Purpose |
|---|---|
| `file_embeddings` | Chunked file content with vector(1024) embeddings |
| `issue_embeddings` | Issue content vectors for duplicate/similarity detection |
| `resolution_embeddings` | Past resolution patterns for approach reuse |

### Metrics Tables

| Table | Purpose |
|---|---|
| `daily_metrics` | Per-repo daily rollups: issues detected/triaged/resolved/escalated, PRs created/merged/rejected, token usage, cost, cache hit rate |

### Migrations

Migrations live in `src/db/migrations/` and run automatically on container startup:

1. `001_initial_schema.sql` -- Core tables, extensions, indexes, triggers
2. `002_embeddings.sql` -- Vector embedding tables and IVFFlat indexes
3. `003_metrics.sql` -- Daily metrics aggregation table

---

## Security Model

### Bedrock Guardrails

A Bedrock Guardrail is provisioned via OpenTofu with the following filters:

- **Content filtering:** HATE, VIOLENCE, SEXUAL, MISCONDUCT (HIGH), INSULTS (MEDIUM), PROMPT_ATTACK (HIGH input)
- **PII protection:** EMAIL and PHONE anonymized; SSN, credit cards, AWS keys blocked
- **Contextual grounding:** Grounding and relevance thresholds both set to 0.7

### Path Safety

- **Protected paths** (defined in `config/policy.yaml`): `.github/workflows/**`, `.env*`, `**/secrets/**`, `Dockerfile*`, `tofu/**`, lock files. The agent cannot modify these.
- **Allowed paths:** `src/**`, `lib/**`, `test/**`, `tests/**`, `docs/**`, `README.md`
- Path traversal prevention is enforced at the tool layer (`src/utils/path-safety.ts`)

### Infrastructure Security

- **KMS encryption everywhere:** RDS storage, SQS queues, SNS topics, Secrets Manager, CloudWatch Logs, ECR repositories
- **IAM least privilege:** Separate execution role (ECR pull + log write + secret read) and task role (SQS, SNS, Bedrock, Secrets Manager). Model access scoped to exactly 4 Bedrock model ARNs.
- **Network isolation:** ECS tasks in private subnets, no public IPs, Bedrock access via VPC condition
- **Container hardening:** `cap_drop: ALL`, `no-new-privileges`, `read_only` filesystem, resource limits, json-file logging with rotation
- **Ports bound to 127.0.0.1 only** in local development

---

## Model Strategy

| Use Case | Model | Rationale |
|---|---|---|
| Triage / classification | Claude Haiku 4.5 | Fast, cheap, sufficient for categorization |
| Notification drafting | Claude Haiku 4.5 | Simple text generation |
| Code implementation | Claude Sonnet 4 | Strong coding ability, good cost/quality balance |
| Code review | Claude Sonnet 4 | Needs to evaluate correctness, security, style |
| Controller validation | Claude Sonnet 4 | Grounding checks, fact verification |
| Complex decisions | Claude Opus 4 | Reserved for edge cases requiring deeper reasoning |
| Embeddings | Amazon Titan Embed Text v2 | 1024-dim vectors, native AWS integration |

The **adversarial Coder/Reviewer pattern** is a core design choice: the Coder and Reviewer are separate agents using the same model class but different prompts and temperatures. The Reviewer has no incentive to approve -- it evaluates against explicit criteria (correctness, scope, tests, style, security, performance) and can request changes or escalate. The Controller sits above both and validates the full interaction before allowing a merge.
