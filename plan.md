# Plan — Multi-Agent Code Review System (DevFlow / Udacity cd14715)

**Status:** planning complete, implementation not started
**Working dir:** `C:\Users\a.sorstkins\Documents\Agent-orchestration` (currently empty except `.git`)
**Starter source:** `https://github.com/udacity/cd14715-claude-code-classroom` → `project/starter`
**Target repo to analyze:** `udacity/cd14715-simple-todo-app`, PRs #1, #2, #3

---

## 0. Ground truth from the starter (already inspected)

The starter was cloned and read. Facts the plan depends on:

**Provided (do not rewrite):**

| File | What it gives us |
|---|---|
| `src/types/analysis-results.ts` | `CodeQualityResultSchema`, `TestCoverageResultSchema`, `RefactoringSuggestionSchema` + `*JSONSchema` exports (via `zodToJsonSchema(s, { $refStrategy: 'root' })`) |
| `src/types/report-types.ts` | `ReviewReportSchema`, `ReviewReportJSONSchema` |
| `src/utils/logger.ts` | `logger`, `logReviewStart`, `logReviewComplete`, `logReviewError`, `logAgentStart`, `logAgentComplete` |
| `src/utils/report-generator.ts` | `ReportGenerator` class with **instance** methods `generateMarkdownReport(report)`, `generateHTMLReport(report)`, `generateJSONReport(report)` — all return `string` |
| `.claude/skills/javascript-best-practices/SKILL.md` | the one example skill |
| `package.json` | deps: `@anthropic-ai/claude-agent-sdk@^0.1.55`, `@modelcontextprotocol/sdk`, `dotenv`, `winston`, `zod@^3`, `zod-to-json-schema`; devDeps `tsx`, `vitest@^4`, `typescript@^5.3`. Scripts: `dev` (tsx src/main.ts), `test` (vitest run), `lint` (tsc --noEmit), `build` (tsc) |
| `tsconfig.json` | ES2022, `module: ESNext`, `moduleResolution: bundler`, `strict`, **`noUncheckedIndexedAccess: true`**, `include: ["src"]`, `exclude: [..., "tests"]` |

**Stubs to implement:** `src/config/mcp.config.ts` (two empty objects), `src/orchestrator.ts` (empty class that throws `Not implemented`), `src/main.ts` (TODO comments only), `src/utils/error-handler.ts` (`withRetry`/`withTimeout` throw), `src/utils/rate-limiter.ts` (5 methods throw), `src/utils/index.ts` (commented-out exports), `src/agents/index.ts` + `src/prompts/index.ts` (empty), `tests/orchestrator.test.ts` (empty `it` bodies).

**Exact schema shapes the agents must return** (non-negotiable contracts — every enum value matters):

```
CodeQualityResult   = { file, issues: [{ line:number, severity: critical|high|medium|low|info,
                        category: security|performance|maintainability|style|bug-risk|best-practice,
                        description, suggestion }], overallScore: 0..100, summary }

TestCoverageResult  = { file, hasTests:boolean, testFiles:string[],
                        untestedPaths: [{ type: function|class|branch|edge-case, location,
                        priority: critical|high|medium|low, reasoning, suggestedTest }],
                        coverageEstimate: 0..100, summary }

RefactoringSuggestion = { file, suggestions: [{ type: extract-function|rename|modernize|simplify|
                          pattern-improvement, location, impact: low|medium|high,
                          description, before, after, benefits }], summary }

ReviewReport = { pullRequest:{owner,repo,number},
                 fileReviews:[{ file, codeQuality, testCoverage, refactorings }],
                 summary:{ totalFiles, overallScore, criticalIssues, highPriorityTests,
                           refactoringOpportunities },
                 recommendations:[{ priority: critical|high|medium|low, category, description, files[] }],
                 metadata:{ analyzedAt:string, duration:number, agentVersions: Record<string,string> } }
```

Note the field is `refactorings` inside `fileReviews` while the schema is named `RefactoringSuggestionSchema` — an easy mismatch to make.

---

## 1. Decisions up front

| Question | Decision | Why |
|---|---|---|
| Where does the code live? | Copy `project/starter/**` into this repo root, commit as baseline, implement on top | keeps a clean starter-vs-my-work diff; rubric expects `src/agents/...` paths |
| Run locally or on Vocareum? | Implement + unit-test locally on Windows; generate the 9 reports wherever the API key lives | MCP `npx` servers work on Windows, but the GitHub MCP server is the risk point (§7) |
| Subagents parallel or serial? | Parallel per file (all three Task calls issued in one turn), files processed in small sequential batches | matches the rubric and is what the rate limiter exists to protect |
| Report naming | `reports/pr-<n>-review.{json,md,html}` → 9 files | predictable for a grader |

---

## 2. Phase 0 — Scaffold

1. Copy starter into working dir: `src/`, `tests/`, `.claude/`, `.env.example`, `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json`, `README.md`.
2. `npm install` at repo root (standalone — not using the monorepo workspace).
3. `cp .env.example .env`, then set:
   - `ANTHROPIC_MODEL=claude-sonnet-4-5-20250929`
   - `PROJECT_ROOT=C:/Users/a.sorstkins/Documents/Agent-orchestration` (must be the dir containing `.claude/skills/`)
   - `GITHUB_TOKEN=` (recommended — see §7)
   - `LOG_LEVEL=info`
   - `ANTHROPIC_API_KEY` (local) — **confirm `.gitignore` covers `.env` before any commit**
4. `npm run lint` → should pass on the untouched starter. Baseline commit.
5. `mkdir reports`.

**Checkpoint:** `npm run lint` clean.

---

## 3. Phase 1 — MCP config (`src/config/mcp.config.ts`)

The TODO comments already answer the research questions; follow them literally:

```ts
export const mcpServersConfig = {
  github: {
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '' }
  },
  eslint: {
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@eslint/mcp@latest'],
    env: {}
  }
};
```

Notes:
- ESLint MCP needs no auth.
- The env-var rename (`GITHUB_TOKEN` → `GITHUB_PERSONAL_ACCESS_TOKEN`) is the point of the exercise; comment it.
- `@modelcontextprotocol/server-github` is the archived reference server; the maintained one is `github/github-mcp-server`. **Keep the starter's package** (that is what is graded) and hold the alternative as a fallback (§7).
- Type it against the SDK's `McpStdioServerConfig` if that type is exported.

---

## 4. Phase 2 — Agents, prompts, skills

### 4.1 Prompts (`src/prompts/*.prompt.ts`)

One exported `const` string per subagent, plus `buildOrchestratorPrompt(owner, repo, prNumber)`.

Every subagent prompt carries five blocks:

1. **Role + scope** — one sentence, plus an explicit "do not do the other two agents' jobs" line (prevents three near-identical findings).
2. **Process** — numbered: read the file with `Read`; `Grep`/`Glob` for related files; invoke skills by extension; analyze; return JSON.
3. **Skill invocation table** — `.ts/.tsx → typescript-patterns`, `.js/.jsx → javascript-best-practices`, `.py → python-code-review`, and **all files → security-analysis** (code-quality agent only); `performance-optimization` for hot paths.
4. **Severity / priority rubric** — concrete, e.g. `critical` = exploitable (injection, auth bypass, secret in source, unvalidated input reaching a sink); `high` = data loss or crash path; `medium` = real maintainability cost; `low`/`info` = style. Without this the model labels everything "medium".
5. **Output contract** — the exact JSON shape inline with literal enum values, plus: return JSON only, no prose, no markdown fence; `before`/`after` must be real code copied from the file, never placeholders (a stated grading requirement).

Per-agent differentiation:
- **code-quality** — security (injection, XSS, secrets, authz, unsafe deserialization, prototype pollution), performance (N+1, sync I/O, O(n²) inside loops, unbounded memory), maintainability, bug-risk. `overallScore` from a stated deduction rule (start 100; −25 critical, −12 high, −5 medium, −2 low; floor 0) so scores are reproducible rather than vibes.
- **test-coverage** — first `Glob`/`Grep` for sibling tests (`*.test.*`, `*.spec.*`, `__tests__/`) and set `hasTests`/`testFiles` from what it actually finds; then enumerate exported functions/classes/branches and flag those with no matching assertion. `suggestedTest` must be a runnable test body with a real assertion, not "add a test for X". `coverageEstimate` = tested paths / total paths, with the counts shown in `summary`.
- **refactoring** — structure and modernization only: extract-function for long/multi-responsibility functions; modernize (`var`→`const`, callbacks→async/await, `?.`/`??`, destructuring); simplify (dead code, duplicated branches, nested ternaries); pattern-improvement (strategy/factory/guard clauses). `before`/`after` code pairs are mandatory.

### 4.2 Agents (`src/agents/*.ts`)

```ts
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

export const codeQualityAnalyzer: AgentDefinition = {
  description: '<when the orchestrator should pick this one — the dispatch signal>',
  prompt: CODE_QUALITY_ANALYZER_PROMPT,
  tools: ['Read', 'Grep', 'Glob', 'Skill' /* + eslint MCP tools for this one */],
  model: 'inherit'
};
```

Rules:
- `description` is how the orchestrator routes — phrase it as "Use this agent to …", name the trigger, keep it to one or two sentences.
- `model: 'inherit'` on all three (required).
- Least privilege: no `Write`/`Edit`/`Bash` anywhere. `Read`, `Grep`, `Glob`, `Skill` for all three; code-quality additionally gets the ESLint MCP tool(s).
- `src/agents/index.ts` re-exports all three; `src/prompts/index.ts` re-exports all four prompts.
- **Settle the import-extension convention:** `utils/index.ts` uses `./logger.js` while `orchestrator.ts` uses `./types/report-types` with no extension. With `moduleResolution: bundler` both compile, but `tsx` is happier with consistent `.js` specifiers. Pick `.js` everywhere and confirm with `npm run lint` plus one real `tsx` run.

### 4.3 Skills (`.claude/skills/`)

`.claude/skills/README.md` requires **at least 2 new skills** beyond the provided example:
- `typescript-patterns/SKILL.md` (required)
- `security-analysis/SKILL.md` (required)
- one of `performance-optimization/` or `python-code-review/` (optional — do one)

Format: frontmatter with `description:`, then sections, then an `## Output:` section; under ~500 lines. These must exist before any agent references them, or the `Skill` calls fail.

---

## 5. Phase 3 — Orchestrator (`src/orchestrator.ts`)

### 5.1 Shape

```ts
export interface OrchestratorOptions {
  model?: string;              // default process.env.ANTHROPIC_MODEL
  maxTurns?: number;           // default ~60-80 for 3 agents x N files
  timeoutMs?: number;          // whole-review timeout
  rateLimits?: Partial<RateLimiterConfig>;
  cwd?: string;                // default process.env.PROJECT_ROOT
}

export class CodeReviewOrchestrator {
  async reviewPullRequest(owner, repo, prNumber): Promise<ReviewReport>
}
```

### 5.2 `query()` options to assemble

- `prompt`: `buildOrchestratorPrompt(owner, repo, prNumber)`
- `options.model`: from env, **never hardcoded**
- `options.agents`: `{ 'code-quality-analyzer': …, 'test-coverage-analyzer': …, 'refactoring-suggester': … }` — these keys are the names the prompt must use verbatim
- `options.mcpServers`: `mcpServersConfig`
- `options.allowedTools`: must include **`Task`** (no subagents without it), plus `Read`, `Grep`, `Glob`, `Skill`, and the MCP tool names (`mcp__github__*`, `mcp__eslint__*` — confirm the exact prefix the SDK generates)
- `options.permissionMode`: `'bypassPermissions'` for unattended CI-style runs (document the choice; `acceptEdits` is insufficient since nothing can answer a prompt)
- `options.cwd`: `PROJECT_ROOT`, **and** `options.settingSources: ['project']` so `.claude/skills/` is discovered. ⚠️ Verify this option name against the installed SDK; if skills do not load, check this first.
- `options.maxTurns`: generous (60+) — each file costs roughly three Task round-trips
- `options.outputFormat`: structured-output config carrying `ReviewReportJSONSchema`. ⚠️ **Verify the exact field shape** by reading `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` for v0.1.55 — do not guess whether it is `{ type: 'json_schema', schema }` or something else, nor what the result field is called.

### 5.3 Consuming the stream

```
for await (const message of query({...})) {
  // log assistant/tool messages at debug level
  // on message.type === 'result': capture structured output + usage
}
```

- Extract structured output from the terminal `result` message; fall back to parsing JSON out of the result text (tolerating a code fence) if the structured field is absent.
- Validate with `ReviewReportSchema.safeParse` — **`safeParse`, not `parse`** — so a failure produces a logged `ReviewError(VALIDATION_FAILED)` carrying `error.issues` rather than an unhandled throw.
- Fill `metadata.duration` from a wall-clock timer, `metadata.analyzedAt` from `new Date().toISOString()`, `metadata.agentVersions` from a const map.
- Recompute `summary` defensively from `fileReviews` (count `severity === 'critical'`; count tests with `priority` critical/high; total suggestions; mean quality score) instead of trusting the model's arithmetic — the rubric requires scores *calculated from aggregated findings*.

### 5.4 Resilience

- Wrap the query in `withTimeout` and `withRetry` from the error handler.
- Rate-limit through `globalRateLimiter` / `withRateLimit`.
- Graceful degradation: if a subagent's slice is missing for a file, synthesize a well-formed "analysis unavailable" record (empty arrays, neutral score, summary explaining the failure) so `ReviewReportSchema` still validates and the report still renders. Log a warning — never silently fabricate findings.

### 5.5 Orchestrator prompt (`orchestrator.prompt.ts`)

Must instruct, in order:
1. Fetch PR metadata and changed files via the GitHub MCP tools (`get_pull_request`, `get_pull_request_files` on the reference server — confirm real tool names from the runtime tool list).
2. Skip non-reviewable files (lockfiles, `dist/`, images, `.md`) and state the filter; cap to the top N files by change size on large PRs and say so in the report summary.
3. **For each file, use all three agents**, in imperative voice: "Use the code-quality-analyzer agent to analyze `<path>`", plus "launch the three agents for a file in a single message so they run in parallel."
4. If one agent fails, continue with the other two and note it.
5. Emit exactly one `ReviewReport` JSON matching the schema, with `recommendations` derived from the highest-severity findings across files.

---

## 6. Phase 4 — Utilities, CLI, tests

### 6.1 `error-handler.ts`
- `withRetry(fn, maxRetries=3, delayMs=1000)` — attempts 1..maxRetries; on failure wait `delayMs * 2**(attempt-1) + Math.random()*100`; keep the last error; throw `new ReviewError(msg, ErrorCodes.RETRY_EXHAUSTED, { attempts, lastError })` when exhausted. Do not swallow the cause.
- `withTimeout(fn, timeoutMs, errorMessage)` — `Promise.race([fn(), timer])`; timer rejects with `ReviewError(errorMessage, ErrorCodes.AGENT_TIMEOUT, { timeoutMs })`; **clear the timer in a `finally`** so the process can exit.

### 6.2 `rate-limiter.ts`

Implement the five stubs exactly as their TODOs describe:
- `pruneOldRecords()` — keep records with `timestamp > Date.now() - 60000`.
- `canProceed(est)` — prune, then `activeRequests < maxConcurrent && requestsInWindow < maxRequestsPerMinute && tokensInWindow + est <= maxTokensPerMinute`.
- `waitForSlot()` — `new Promise<void>(res => this.waitQueue.push(res))`.
- `waitForRateLimit(est)` — `while (!canProceed(est))` { prune; `if (!requestHistory.length) break;` wait `min(5000, max(100, oldest.timestamp + 60000 - Date.now() + 100))` }.
- `acquire(est)` — if `activeRequests >= maxConcurrent` await `waitForSlot()`; await `waitForRateLimit(est)`; `activeRequests++`; push `{ timestamp: Date.now(), tokens: est }`.
- Mind `noUncheckedIndexedAccess`: `requestHistory[0]` is `T | undefined` — guard it.
- Then uncomment the exports in `src/utils/index.ts`.

### 6.3 `main.ts`
- Parse `owner`, `repo`, `prStr`; validate presence; `Number.parseInt` + `Number.isInteger` + `> 0`; print usage and `process.exit(1)` on bad input.
- Auth validation: accept **either** `ANTHROPIC_API_KEY` **or** (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_REGION`); log `🔐 Using Anthropic API authentication` / `🔐 Using AWS Bedrock authentication`; exit showing both options if neither is present.
- Require `ANTHROPIC_MODEL`; exit with the Bedrock vs. direct-API examples if missing.
- Run the orchestrator, then `new ReportGenerator()` and write all three formats to `reports/pr-<n>-review.{json,md,html}` (create the dir first).
- `catch`: use `formatError`, log via `logReviewError`, `process.exit(1)` with a human message that distinguishes PR-not-found, rate-limited, timeout, and validation-failed.

### 6.4 Tests (`tests/`)

The rubric asks for schema validation, edge cases, JSON-schema export checks, and an integration test. The starter ships `tests/orchestrator.test.ts`; the brief also names `tests/schemas.test.ts` — **write both**:

- `schemas.test.ts` — each schema accepts a valid fixture; rejects bad enum values, out-of-range `overallScore` (−1, 101) and `coverageEstimate`, missing required fields, wrong types. Boundary values 0 and 100 **accepted**. Empty `issues`/`untestedPaths`/`suggestions`/`fileReviews` arrays accepted. `*JSONSchema` exports are objects with `type: 'object'`, the expected top-level `properties` keys, and no unresolved `$ref` at the root.
- `orchestrator.test.ts` — fill the described cases: default options; custom rate limits; `vi.mock` the SDK's `query` to return a canned structured output, then assert aggregation, Zod validation, and graceful handling of a missing subagent slice. Keep the real-API test `it.skip`.
- Note `tsconfig` excludes `tests`, so `npm run lint` will not type-check them — vitest still runs them. Optionally add `tsconfig.test.json`; avoid editing the provided tsconfig without reason.

**Checkpoint:** `npm test` green, `npm run lint` clean.

---

## 7. Phase 5 — The 9 deliverable reports

```
npm run dev udacity cd14715-simple-todo-app 1   # "add clean code fixture" (merged)
npm run dev udacity cd14715-simple-todo-app 2   # "Add search functionality for todos" (open)
npm run dev udacity cd14715-simple-todo-app 3   # "Add premium subscription features" (open)
```

Produces 9 files in `reports/`. **Verify each one** before calling it done — write a small `scripts/verify-reports.ts` that:
- parses each JSON and runs `ReviewReportSchema.safeParse` (cheap insurance against a grader finding `undefined`);
- asserts every `fileReviews[].codeQuality.issues[]` has a real `line` and `severity`, and no empty descriptions;
- asserts `testCoverage.untestedPaths[].suggestedTest` contains actual test code;
- asserts `refactorings.suggestions[].before`/`after` are non-empty and differ;
- checks `summary.overallScore` is consistent with the per-file scores.

Then eyeball: HTML opens and renders in a browser; Markdown renders on GitHub.

### Known risks at this step

| Risk | Mitigation |
|---|---|
| `@modelcontextprotocol/server-github` is archived and may not expose the PR tools | Fallback A: `github/github-mcp-server`. Fallback B: orchestrator shells out to `gh pr diff` / `gh api` — needs `Bash` in `allowedTools`, a deviation to document. Decide only if the primary fails |
| Agents need the PR's *file contents*, but `Read` only sees the local filesystem | (a) orchestrator fetches each file's content via GitHub MCP and passes it inline in the Task prompt, or (b) check out the PR branch into a temp dir and point `Read` there. **Try (a) first** — no extra tools needed; (b) is the fallback for large files. This is the most likely thing to go wrong: prototype it on PR #1 before building out |
| GitHub anonymous rate limit (60 req/h) | set `GITHUB_TOKEN` with scopes `repo`, `read:org` |
| `maxTurns` exhaustion on the larger PR #3 | raise `maxTurns`, cap files per run, record the cap in the report |
| `npx` stdio MCP spawn on Windows | if spawn misbehaves, generate reports under WSL or on Vocareum |

---

## 8. Open items to resolve during implementation

1. **Exact `outputFormat` / structured-output API** for `@anthropic-ai/claude-agent-sdk@0.1.55` — read the shipped `.d.ts` first; do not guess field names.
2. **`settingSources`** — confirm the option that makes `.claude/skills/` load from `cwd`.
3. **MCP tool-name prefixes** the SDK generates for `allowedTools` (e.g. `mcp__github__get_pull_request_files`) — log the available tool list on a first dry run and copy the real names.
4. **Which credential is actually available here** — `ANTHROPIC_API_KEY` is not in the environment yet. Nothing in Phase 5 can run without it; if it exists only in Vocareum, Phases 0–4 still complete locally and only report generation moves there.
5. Whether to keep the starter's `package-lock.json` or regenerate (a standalone install may drift from the workspace lock).

---

## 9. Order of work and checkpoints

```
P0 scaffold ──► lint clean, baseline commit
P1 mcp.config ──► tsc clean
P2 skills ──► agents ──► prompts ──► tsc clean
P3 orchestrator ──► DRY RUN on PR #1 with a tiny file cap, inspect the raw stream
      └─ resolve open items 1-3 here, before writing more code
P4 utils ──► main.ts ──► tests ──► npm test green
P5 three real runs ──► verify-reports ──► 9 files ──► final commit
```

Dry-run at the end of P3 rather than after P4: the SDK-shape unknowns in §8 are the only things that can force a redesign, and they surface the moment the first real query runs.

---

## 10. Deliverables checklist (grading)

- [ ] `src/config/mcp.config.ts` — GitHub + ESLint stdio servers, token remapped
- [ ] `src/agents/{code-quality-analyzer,test-coverage-analyzer,refactoring-suggester,index}.ts` — `AgentDefinition`, `model: 'inherit'`, `Skill` tool, least-privilege tools
- [ ] `src/prompts/{orchestrator,code-quality-analyzer,test-coverage-analyzer,refactoring-suggester}.prompt.ts` + `index.ts`
- [ ] `.claude/skills/` — at least 2 new skills (`typescript-patterns`, `security-analysis`)
- [ ] `src/orchestrator.ts` — `query`, `agents`, `Task` in `allowedTools`, `outputFormat` + `zod-to-json-schema`, `safeParse` validation, aggregation, graceful failure
- [ ] `src/main.ts` — arg validation, env/auth validation, 3-format report output, meaningful error messages
- [ ] `src/utils/error-handler.ts` — `withRetry` (exponential backoff + jitter), `withTimeout` (`Promise.race`)
- [ ] `src/utils/rate-limiter.ts` — all 5 methods, sliding window, concurrency cap
- [ ] `src/utils/index.ts` — exports uncommented
- [ ] `tests/` — schema validity, invalid-input rejection, edge cases, JSON-schema exports, mocked integration; `npm test` green
- [ ] `reports/` — 9 files (3 PRs × json/md/html), all populated and schema-valid
