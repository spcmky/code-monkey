# Configuration

Code Monkey uses a layered configuration system: YAML files for policies, agents, and rules; environment variables for infrastructure and secrets.

---

## Config Files

All config files live in the `config/` directory and are mounted read-only into containers.

### config/policy.yaml

Controls what the agent can and cannot do.

**Scope control:**

```yaml
scope:
  allowed_labels:      # Issues with these labels are eligible for autonomous action
    - bug
    - enhancement
    - feature
    - question
    - documentation
    - dependencies
  escalate_labels:     # Issues with these labels are immediately escalated
    - security
    - breaking-change
    - infrastructure
    - urgent
    - needs-discussion
```

**Path controls:**

```yaml
paths:
  protected:           # Glob patterns the agent must never modify
    - ".github/workflows/**"
    - ".env*"
    - "**/secrets/**"
    - "Dockerfile*"
    - "tofu/**"
    - "**/*.lock"
  allowed:             # Glob patterns the agent may modify
    - "src/**"
    - "lib/**"
    - "test/**"
    - "docs/**"
    - "README.md"
```

Path matching uses [minimatch](https://github.com/isaacs/minimatch) glob syntax.

**Thresholds:**

| Setting | Default | Description |
|---|---|---|
| `max_diff_lines` | 500 | Max total diff lines before escalation |
| `max_files_changed` | 20 | Max files in a single PR before escalation |
| `max_retries` | 3 | Retry attempts before escalating |
| `confidence_threshold` | 0.7 | Minimum model confidence to act autonomously |
| `grounding_threshold` | 0.7 | Bedrock guardrail grounding score minimum |
| `relevance_threshold` | 0.7 | Bedrock guardrail relevance score minimum |
| `max_tokens_per_issue` | 100,000 | Token budget per issue across all agents |

**Escalation conditions:**

Any of the following triggers human review:

- `label_match` -- issue carries an `escalate_labels` label
- `diff_size_exceeded` -- diff exceeds `max_diff_lines` or `max_files_changed`
- `protected_path` -- changeset touches a protected path
- `confidence_below` -- model confidence below `confidence_threshold`
- `test_failure_retries` -- tests still fail after `max_retries` attempts
- `reviewer_rejected_x2` -- reviewer requested changes twice on same PR
- `high_complexity` -- cyclomatic or cognitive complexity above normal

**Rate limits:**

| Setting | Default | Description |
|---|---|---|
| `max_issues_per_hour` | 10 | Max issues processed per hour |
| `max_prs_per_hour` | 5 | Max PRs created per hour |
| `max_comments_per_hour` | 20 | Max GitHub comments per hour |
| `cooldown_after_failure_minutes` | 15 | Cooldown period after a failure |

**Auto-close:**

| Setting | Default | Description |
|---|---|---|
| `stale_days` | 30 | Days of inactivity before auto-close |
| `labels` | wontfix, duplicate, invalid | Issues with these labels are auto-closed |

---

### config/agents.yaml

Per-agent model selection, token limits, temperature, tools, and constraints.

**Agent configuration summary:**

| Agent | Model | Temp | Max Tokens | Key Settings |
|---|---|---|---|---|
| Watcher | -- | -- | -- | Polls issues, PRs, comments; excludes dependabot/renovate |
| Triage | Haiku | 0.1 | 2048 | Categories: bug, feature, question, documentation, dependency_update, refactor, out_of_scope |
| Coder | Sonnet | 0.3 | 8192 | 7 tools, must create branch, must run tests, `code-monkey/` branch prefix |
| Reviewer | Sonnet | 0.1 | 4096 | 6 criteria, 3 actions (approve/request_changes/escalate), reasoning required |
| Notifier | Haiku | 0.3 | 1024 | SNS channel, notifies on escalation/merge/failure/rate_limit/daily_summary |
| Controller | Sonnet | 0.1 | 2048 | Grounding check, scope check, fact check; 90-day audit retention |

**Coder tools:**

| Tool | Purpose |
|---|---|
| `file_read` | Read file contents |
| `file_write` | Write/create files |
| `file_search` | Search across codebase |
| `shell_exec` | Run shell commands |
| `git_diff` | View git diffs |
| `test_runner` | Execute test suite |
| `linter` | Run linter |

**Coder constraints:**
- Must create a branch with prefix `code-monkey/`
- Must run tests before submitting
- Commit messages prefixed with `[code-monkey]`
- Max 3 retries on failure

**Reviewer criteria:**
- Correctness, scope, tests, style, security, performance
- Must provide reasoning for every decision
- Can approve, request changes, or escalate

---

### config/rules.yaml

Deterministic routing rules evaluated **top-to-bottom, first match wins**. Matching rules bypass the AI triage agent to save cost and latency.

**Rule summary:**

| Rule | Match Condition | Action |
|---|---|---|
| `dependency_update` | Title contains "bump"/"update dependency"/"upgrade", or author is dependabot/renovate/snyk, or `dependencies` label | Classify as `dependency_update`, priority low, skip triage |
| `typo_fix` | Title contains "typo"/"spelling"/"grammar" | Classify as `documentation`, priority low, skip triage |
| `question` | Title contains "how to"/"how do"/"is it possible"/"can I"/"?" | Classify as `question`, skip coder |
| `security_escalate` | Title or body contains "security"/"vulnerability"/"CVE"/"exploit" | Escalate immediately, notify |
| `large_feature` | Labels include feature/enhancement AND body > 2000 chars | Escalate (needs human scoping) |
| `duplicate_check` | Title similarity >= 0.9 against open issues in same repo | Comment, add `duplicate` label, close |
| `stale_warning` | Inactive > 21 days, open, not pinned/in-progress | Comment warning, add `stale` label |
| `fallback` | Always matches | Hand off to AI triage |

Rules support `any` (OR) and `all` (AND) match groups, with field matchers for `title`, `body`, `author`, `labels`, `state`, and `last_activity_days`.

---

## Environment Variables

See [deployment.md](deployment.md#environment-variables-reference) for the full reference table.

Key points:
- `.env.example` is the template -- copy to `.env` for local development
- In Docker Compose, `env_file: .env` loads all variables; some are overridden in `environment:` blocks (e.g., `DB_HOST=postgres`)
- In AWS, secrets (`DB_CREDENTIALS`, `GITHUB_PAT`) are injected from Secrets Manager via ECS task definition `secrets` blocks
- `AWS_ENDPOINT_URL` should only be set for LocalStack; leave blank for real AWS

---

## Config Loader

The configuration loader (`src/config/loader.ts`) validates all configuration at startup using **Zod schemas**.

**What gets validated:**

- `AppConfig` (from environment variables): poll interval cron format, watched repos must match `owner/repo` pattern, database connection params, AWS resource ARNs (validated as proper ARN format), SQS URLs (validated as URLs)
- `PolicyConfig` (from `config/policy.yaml`): scope, agent settings, escalation thresholds, model IDs

**Behavior on invalid config:** The Zod parser throws a `ZodError` with detailed field-level messages. The application exits on startup if config is invalid -- fail fast rather than running with bad config.

**Type safety:** The parsed config types (`AppConfig`, `PolicyConfig`) are exported and used throughout the codebase, providing compile-time type checking on all config access.
