---
name: add-claude-harness
description: Use when onboarding Claude Code to an existing project that has no .claude/ directory. Covers the full process: repo exploration, repo_analysis.md, CLAUDE.md, workstream identification, skill writing, code health audit, and refactoring skill.
---

# Adding a Claude Code Harness to an Existing Project

## What a Harness Is

A Claude Code harness is the combination of:

1. **`CLAUDE.md`** — project-level instructions that apply to every conversation: how to run the project, coding standards, and directives Claude must follow.
2. **`.claude/skills/`** — skill files encoding domain knowledge too specific for `CLAUDE.md`: external API quirks, state invariants, multi-agent dispatch strategies, refactoring protocols.
3. **`repo_analysis.md`** — a human- and agent-readable map of the codebase that serves as a stable reference when source files are too large to read in full.
4. **`docs/code-review-findings.md`** — a prioritized list of known issues to address.

`CLAUDE.md` applies universally. Skills are invoked on demand for specific tasks. The analysis doc is a canonical reference. The findings doc is the work queue.

## Why Skills Rather Than CLAUDE.md Alone

`CLAUDE.md` covers universal rules. Skills encode the *how* for specific domains:

- The exact WebSocket protocol of an external provider (auth headers, message shapes, keepalive timing)
- State object invariants not visible from the types alone (race conditions, sequencing rules)
- SDK call patterns that differ between major versions
- Idempotency requirements for external systems (SQS, database upserts)
- Multi-agent dispatch boundaries

Without skills, an agent on a new task re-derives conventions by re-reading source. With skills, it arrives knowing the non-obvious constraints.

---

## Phase 1 — Explore the Repository

Read in this order. Later steps depend on earlier ones.

### 1a. Entry points

`README.md`, root manifest (`package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod`).

Extract: what the project does, top-level commands, whether it is a monorepo.

### 1b. Package/module manifests

For a monorepo (npm workspaces, Nx, Poetry workspaces, Cargo workspace), read each workspace manifest. Extract: the dependency graph between packages — which packages are shared contracts (imported by many, changes have wide impact) vs. leaf packages (import nothing internal, safe to change in isolation).

### 1c. Configuration files

`tsconfig.json`, eslint/biome config, test runner config, `Dockerfile`, `infra/` or `deploy/` directories.

Extract: compiler options that affect code patterns (`verbatimModuleSyntax`, `strict`), test runner choice (Jest vs Vitest vs Node built-in vs pytest), containerized local dev setup.

### 1d. Key source files — 5–10 files maximum

- The main entry point (`src/index.ts`, `main.py`, `cmd/server/main.go`)
- The central state object or context type (if it exists)
- The primary external integration file (the file that calls the external API)
- The persistence layer
- One test file (to see the test runner pattern in use)
- The shared types/contracts module

Do not read everything. Read what you need to understand how data flows from input to output.

### 1e. Implementation status

Look for: TODO comments in source, an implementation plan document (`docs/plan.md`, `IMPLEMENTATION_PLAN.md`), open GitHub issues (if accessible). These shape which skills are worth writing and what the work queue looks like.

---

## Phase 2 — Write `repo_analysis.md`

Save to the repo root, or `docs/` if the project has a docs convention. Write it to remain accurate over weeks, not just for this session.

### Required sections

**What the project does** (2–4 sentences maximum)

**Repository layout** — annotated directory tree with one-line responsibilities per directory:

```
apps/
  gateway/    Fastify WebSocket server — transcription, agent orchestration
  web/        React frontend
packages/
  shared/     Typed event contracts, Zod schemas
  agent-core/ AI agent with heuristic fallback
```

**Package dependency graph** — which packages import which. This reveals shared contracts (change here, all consumers break) vs. leaf packages (safe to change in isolation).

**Tech stack table** — layer vs. technology. Include versions where the API surface changed between major versions.

**Key source files table** — file path vs. one-sentence responsibility. 10–15 files maximum.

**How to run the project** — exact commands, exact env var names. Separate sections for: local demo (no API keys), live integrations (with API keys), worker/batch replay mode.

**How to run tests** — all commands. Include per-package variants for monorepos.

**Environment variables reference** — variable name, which package uses it, purpose.

**Implementation status** — one paragraph: what is fully complete, what is in progress. Include the date — this section decays fastest.

---

## Phase 3 — Write `CLAUDE.md`

`CLAUDE.md` is loaded into every Claude Code conversation in this project. Keep it under ~100 lines. More than that dilutes the important parts.

### Required sections

**Project Context** — 3–5 sentences: what the project does, tech stack summary, monorepo layout in one block. Enough for Claude to orient immediately.

**Commands** — copy from `repo_analysis.md`. At minimum: install, local dev, tests (full suite and per-package), type check / lint, build.

**Coding Standards** — infer from the existing codebase, not from general opinions:
- Type annotation style (explicit everywhere vs. inference-first)
- Import conventions (`type` imports, path aliases, file extensions)
- Module system (`"type": "module"` vs CommonJS)
- Schema/validation approach (Zod, io-ts, Pydantic, etc.)
- Comment policy (match what already exists — don't impose a new standard)
- Where specific kinds of code live (e.g., "all shared types go in `packages/shared/src/events.ts`")

**Instructions** — directives Claude must follow in every conversation:
- Run tests after any code edit (specify the exact commands and order)
- Run typecheck if shared types changed
- Fix failures before reporting success — do not claim the task is done without seeing passing output

### What does NOT go in CLAUDE.md

- Domain-specific API shapes → skills
- State invariants for specific modules → skills
- Multi-agent dispatch strategy → skills
- Known bugs or findings → `docs/code-review-findings.md`
- Anything requiring more than 2–3 lines to explain → skills

---

## Phase 4 — Identify Workstreams and Skill Areas

A workstream is a set of files that can be edited in parallel without merge conflicts. Skills map to workstreams and to domain-specific concerns within them.

### Finding workstreams

Ask: which sets of files can an agent modify simultaneously without touching any of the same files?

Common workstream splits:

| Workstream | Typical files |
|---|---|
| Real-time / streaming path | WebSocket server, event loop, external streaming API client |
| AI / ML path | Model calls, prompt engineering, extraction / classification |
| Async backend | Queue consumers, background jobs, persistence layer |
| Frontend | UI, client-side state, browser APIs |
| Shared contracts | Types, schemas, events — **always sequential, never parallel** |
| Infrastructure | CDK, Terraform, Kubernetes — usually independent |

Cross-cutting concerns that must always be sequential (never parallel):
- Shared type/schema changes (consumers must wait for the new type to exist)
- Tests for features not yet implemented
- Frontend that consumes new event types not yet published by the backend

### Skill types to consider

| Skill type | Write it when... |
|---|---|
| **Core state** | There is a central state object with non-obvious invariants (race conditions, required init order, fields that must stay in sync) |
| **External integration** | There is a third-party API with non-standard auth, message shapes, keepalive/reconnect requirements, or version-specific patterns |
| **AI/LLM orchestration** | The project uses an LLM SDK — major versions differ significantly; encode the exact call patterns in use |
| **Persistence / idempotency** | There is a database or queue with at-least-once delivery, upsert requirements, or idempotency keys |
| **Test writing** | The project uses a non-default test runner (anything other than Jest / pytest / unittest is likely to trip agents) |
| **Parallel dispatch** | The project has two or more independent workstreams and you expect to use multiple agents |
| **Refactoring** | A code audit has produced a findings document — encode the read-before-edit protocol and fix priority |

A small single-package project may only need `CLAUDE.md` plus a test-writing skill. Do not write skills for workstreams that do not exist.

---

## Phase 5 — Write the Skills

### Skill file format

```markdown
---
name: skill-name
description: Use when [specific trigger condition]. One sentence, specific enough to dismiss false positives.
---

# Skill Title

## Section
...
```

The `description` field determines when Claude invokes the skill. Make it specific: "Use when working on `apps/gateway/src/` to wire Deepgram live transcription" is better than "Use for WebSocket work."

### What makes a good skill

**Good:** encodes knowledge that is non-derivable from reading the code, stable over time, and directly actionable.

**Bad:** duplicates `CLAUDE.md`, lists TODOs (those change), describes what the code does rather than constraints an agent must respect, so long that critical invariants are buried in prose.

### Skill writing order

1. **Test-writing skill** — lowest risk, validates that the harness setup works, referenced by every subsequent skill
2. **Core state skill** — foundational for any work in the main module
3. **External integration skills** — build on the state skill
4. **AI/LLM skill** — usually independent of integration skills
5. **Persistence skill** — usually independent of real-time skills
6. **Parallel dispatch skill** — references all other skills by name; must be written after the others exist
7. **Refactoring skill** — written after the code audit; references both the findings doc and companion skills

### Template: test-writing skill

Include:
- The exact import pattern for this project's test runner — agents default to Jest/pytest without this
- File co-location convention (where test files live relative to source)
- All test run commands
- One complete canonical existing test pasted in full as the model to follow
- Integration test pattern if one exists (fixture format + call pattern)
- What NOT to test: private symbols, framework internals, implementation details that don't affect observable behavior

### Template: external integration skill

Include:
- Exact URL format, auth header vs. query param, required request headers
- Actual incoming message type with field names — which fields to trust, which to ignore
- Non-obvious protocol details: keepalive timing, reconnect backoff, message ordering, failure modes
- The complete correct handler in actual code, not pseudocode
- 2–3 common mistakes an agent makes without this skill (the things the README doesn't warn about)

### Template: core state skill

Include:
- Full type definition of the state object with an invariant comment per non-obvious field
- Sequencing rules: what must happen in what order (session start → active → stop)
- The event emission pattern: how to send events correctly (never write to the socket directly)
- How to add new behavior without violating existing invariants (which functions to call, which fields to initialize)
- Extraction or processing sequencing if applicable (what serializes, what can run concurrently)

### Template: persistence / idempotency skill

Include:
- The idempotency key and the upsert pattern — never a plain `INSERT` for at-least-once systems
- The adapter interface: what must be implemented for a new storage backend to be a valid substitute
- How audit/observability metadata is attached — separate from domain record assembly
- DLQ / retry behavior: when to throw (let the queue retry) vs. swallow
- Local vs. production path differences (file fallback vs. real DB) and which must produce identical output

### Template: parallel dispatch skill

Include:
- A table of workstreams with exact file ownership boundaries (an agent must not write outside its boundary)
- What is safe to parallelize and what must be sequential, with reasoning
- Dispatch protocol: step 1 (land shared contract changes), step 2 (parallel batch), step 3 (typecheck + test checkpoint)
- Per-agent dispatch context: which companion skills, which file boundary statement, which test commands
- Review checkpoint commands to run before proceeding to the next batch
- 2–3 concrete example dispatch plans for common multi-area scenarios

---

## Phase 6 — Code Health Audit

Run a review pass after the harness is in place. The findings become the input to the refactoring skill and the work queue for future sessions. Writing the harness first means findings can reference skill names.

### What to look for

**Critical** — functional correctness failures visible to users or downstream systems:
- Silent data loss: truncation, dropped messages, ignored errors
- Hardcoded identity or configuration that should be dynamic (`patientId: 'demo-patient'`)
- Missing runtime validation at system boundaries (WebSocket messages, queue payloads, API responses)

**Medium** — reliability or correctness risks that do not always surface:
- Logic errors in deduplication or merging (wrong precedence, OR vs. winner logic)
- Tautological code (`x ?? x`, redundant guards)
- Race conditions in async paths
- DDL or expensive operations running on every connection instead of once at startup

**Low** — quality and maintainability:
- Deprecated APIs (browser, Node.js, language-level)
- Performance anti-patterns (O(n²) loops, layout reflow in animation frames)
- Magic numbers without named constants
- Module-level mutable state shared across requests
- Demo/test data that looks real (fake PII, hardcoded credentials in version-controlled files)

### Findings file structure

Save to `docs/code-review-findings.md`:

```markdown
# [Project] — Code Review Findings

**Date:** YYYY-MM-DD
**Scope:** [what was reviewed — e.g., "full source tree: apps/, packages/, infra/"]

## Summary

[2–3 sentences: the common theme across critical findings]

| # | Finding | Severity | File |
|---|---|---|---|
| 1 | [short description] | Critical | `path/to/file.ts:line` |

## Critical

### 1 — [Finding name]

**File:** [`path/to/file.ts:line`](../path/to/file.ts#Lline)

[Code snippet showing the problem]

[1–2 sentences: what goes wrong for the user or downstream system]

**Fix:** [Specific — what to add, remove, or change. Not "handle this case" but exactly how.]

---

## Recommended Fix Order

[Ordered list — shared contract changes must precede consuming-package changes]
```

### Fix ordering logic

1. **Shared contract changes first** — any fix that changes a shared type, schema, or event affects all consumers; land it before fixes in consuming packages.
2. **Critical before medium before low** within the same package.
3. **Independent fixes can be parallel** — call this out explicitly so agents can be dispatched in parallel.

---

## Phase 7 — Write the Refactoring Skill

The refactoring skill bridges the findings document to actual code edits. Write it last — it references both the companion skills and the findings document.

### What to include

- **Read-before-edit protocol** — always read the findings doc and analysis doc before editing; never rely on memory for file paths or function names
- **File ownership table** — which files belong to which workstream; an agent editing outside its boundary should escalate, not proceed silently
- **Companion skill routing** — for each area of the codebase, which skill to invoke before editing there
- **Shared contract change sequence** — edit shared file → typecheck → then edit consumers
- **Language/compiler constraints** — the ones that cause failures if violated (`verbatimModuleSyntax`, `strict`, ESNext modules, etc.)
- **Prioritized fix list** — the findings in recommended order with file pointers
- **Test requirements** — which commands to run per package touched; failures must be fixed before claiming success
- **Completion checklist** — typecheck passes, per-package tests pass, integration tests pass if applicable, no new `any` introduced
- **Quick-reference table** — finding area vs. primary file and supporting files

---

## Harness Completeness Checklist

- [ ] `repo_analysis.md` written with all required sections and dated
- [ ] `CLAUDE.md` written with Project Context, Commands, Coding Standards, Instructions
- [ ] `.claude/skills/` directory created
- [ ] Test-writing skill written and accurate for this project's actual test runner
- [ ] Core state skill written if a central state object with non-obvious invariants exists
- [ ] External integration skill for each third-party API the project calls
- [ ] AI/LLM orchestration skill if the project calls an LLM SDK
- [ ] Persistence skill if the project uses a queue or database with at-least-once semantics
- [ ] Parallel dispatch skill written if two or more independent workstreams exist
- [ ] Code health audit run and findings saved to `docs/code-review-findings.md`
- [ ] Refactoring skill written referencing the findings doc and companion skills

---

## Common Mistakes When Building a Harness

**Writing skills before reading the source** — skills written from memory or README alone encode plausible but inaccurate API shapes. Always read the actual implementation first.

**Putting too much in `CLAUDE.md`** — long `CLAUDE.md` files dilute the important instructions. Anything requiring more than a paragraph belongs in a skill.

**Writing skills too early in the project** — if the codebase is rapidly changing, skills encoding specific function signatures will rot. Wait until the core architecture is stable.

**Forgetting the test-writing skill** — agents default to the most common runner for the language. If the project uses anything non-default, an explicit skill is essential.

**Skipping the parallel dispatch skill** — without explicit file boundaries, an agent working across all areas will interleave edits and produce hard-to-review diffs.

**Auditing before the harness is written** — if findings say "see the persistence skill for the correct upsert pattern" but the skill does not yet exist, the reference is dead. Write the harness first, then audit.

**Confusing `repo_analysis.md` with `CLAUDE.md`** — `repo_analysis.md` is a reference document: detailed, stable, for reading when needed. `CLAUDE.md` is an instruction document: concise, authoritative, always loaded. Do not merge them.
