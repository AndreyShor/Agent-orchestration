# How This System Works

*An orientation for someone who knows data science / ML and has used
**LangGraph**, but has never touched the **Claude Agent SDK**.*

This document explains the mental model, walks through exactly what happens
when you run a review, and maps every SDK concept to something you already
know from LangGraph. Code references point at real files in this repo.

---

## 1. The mental-model shift, up front

In LangGraph, **you** draw the graph: nodes, edges, conditional routing, a
shared state object that flows through and gets reduced at each step. The
control flow is explicit and lives in your Python.

The Claude Agent SDK has almost none of that. There is **one black-box
agentic loop** per `query()` call: the model reads a system prompt + the
tools it's allowed to call, and then it decides — turn by turn, entirely on
its own — what to call and when, until it produces a final answer. Your
TypeScript code's job is not to wire a graph; it's to:

1. **Configure** that loop (prompt, tools, sub-agents, output schema), and
2. **Consume** the stream of events it produces, and
3. **Validate/wrap** the final result.

There is no explicit "codeQualityNode → testCoverageNode → aggregatorNode"
graph anywhere in this codebase. The "graph" is the English text of
[`src/prompts/orchestrator.prompt.ts`](src/prompts/orchestrator.prompt.ts) —
the model *reads instructions* that say "use these three agents, in
parallel, per file" and it executes that as a plan, not as code we wrote.

This is the single biggest adjustment coming from LangGraph: **routing logic
lives in prompts, not in your language's control flow.**

### Concept map

| LangGraph (Python)                                   | Claude Agent SDK (this repo)                                                      |
|-------------------------------------------------------|-------------------------------------------------------------------------------------|
| `StateGraph`, nodes, edges                            | One agentic loop per `query()` call; "edges" are the model's own tool-call choices, steered by the system prompt |
| Shared mutable `State` TypedDict/Pydantic model       | No shared state object — the loop's state *is* the conversation transcript (`SDKMessage[]`) |
| A node that is itself a compiled sub-graph            | A **subagent** — an `AgentDefinition` registered in `options.agents`, invoked via the built-in `Task` tool ([`src/agents/*.ts`](src/agents/)) |
| Binding a tool / toolkit to a node                    | `allowedTools` (built-ins: `Read`, `Grep`, `Glob`, `Task`, `Skill`, …) plus `mcpServers` for external tool servers |
| A LangChain `Tool` wrapping a REST API                | An **MCP server** — a standardized subprocess exposing tools over JSON-RPC ([`src/config/mcp.config.ts`](src/config/mcp.config.ts)) |
| A retrieved prompt template / few-shot doc from a vector store | A **Claude Skill** — a static `SKILL.md` file injected into context on explicit request, no embeddings involved ([`.claude/skills/`](.claude/skills/)) |
| `llm.with_structured_output(PydanticModel)`           | `options.outputFormat = { type: 'json_schema', schema }` + reading `structured_output` off the final message |
| Pydantic model + `.model_validate()`                  | Zod schema + `.safeParse()` ([`src/types/`](src/types/)) |
| `RunnableRetry`, custom backoff wrapper               | Hand-rolled `withRetry` / `withTimeout` ([`src/utils/error-handler.ts`](src/utils/error-handler.ts)) — **not** an SDK feature, just our own wrapper code |
| A rate-limiting middleware you bolt on yourself       | Same here — `RateLimiter` ([`src/utils/rate-limiter.ts`](src/utils/rate-limiter.ts)) is pure app code, the SDK has no built-in rate limiter |
| `graph.stream()` yielding state deltas per node       | `query()` returns an `AsyncGenerator<SDKMessage>` — a flat transcript of every turn, assistant message, tool call and tool result, ending in one `result` message |

---

## 2. The actors, concretely

```
                     npm run dev <owner> <repo> <prNumber>
                                   │
                                   ▼
                        src/main.ts   (CLI: arg + env validation)
                                   │
                                   ▼
                 src/orchestrator.ts :: CodeReviewOrchestrator
                        .reviewPullRequest(owner, repo, prNumber)
                                   │
                    builds ONE prompt string, calls query({ prompt, options })
                                   │
                                   ▼
            ┌───────────────────────────────────────────────────┐
            │   THE ORCHESTRATOR AGENT (one query() call)        │
            │   system prompt = buildOrchestratorPrompt(...)     │
            │   tools it can call: Task, Read, Grep, Glob, Skill,│
            │                      mcp__github__*, mcp__eslint__*│
            └───────────────────────────────────────────────────┘
                 │                     │                    │
         calls mcp__github__*   calls Task("code-quality-  calls Task(...) for
         to fetch PR + files    analyzer", file content)    the other 2 agents,
                                       │                     per file, in parallel
                                       ▼
                     ┌─────────────────────────────────┐
                     │  SUBAGENT (nested agentic loop)  │
                     │  system prompt = AgentDefinition │
                     │           .prompt                │
                     │  tools: Read, Grep, Glob, Skill   │
                     │  model: 'inherit'                 │
                     └─────────────────────────────────┘
                                       │
                          calls Skill("security-analysis")
                          → SKILL.md content injected into its context
                                       │
                          returns JSON matching CodeQualityResultSchema
                          as its tool_result back to the orchestrator
                                       │
                                       ▼
            orchestrator aggregates all file × agent results into ONE
            final JSON object matching ReviewReportSchema, which the
            SDK hands back as `structured_output` on the terminal
            `result` message of the original query() stream
                                   │
                                   ▼
          src/orchestrator.ts validates it with ReviewReportSchema
          .safeParse(), recomputes summary counts defensively, stamps
          metadata (timestamp, duration), returns a typed ReviewReport
                                   │
                                   ▼
          src/main.ts hands it to ReportGenerator → writes
          reports/<owner>_<repo>_<prNumber>.{json,md,html}
```

Three nested "agentic loops" are running across one logical review: the
orchestrator, and (three times per file) a subagent. **None of this nesting
is visible as separate function calls in our code** — `query()` is called
exactly once by us; everything inside the box above is the model's own
multi-turn behavior, driven entirely by the prompts we wrote.

---

## 3. Walking through one call, end to end

### 3.1 Entry point — `src/main.ts`

Plain Node CLI code, no SDK involved yet:
- Parses `owner`, `repo`, `prNumber` from `process.argv`.
- Checks that *either* `ANTHROPIC_API_KEY` *or* AWS Bedrock creds are
  present, and that `ANTHROPIC_MODEL` is set.
- Constructs `new CodeReviewOrchestrator()` and calls
  `.reviewPullRequest(owner, repo, prNumber)`.
- On success, feeds the returned `ReviewReport` object into
  `ReportGenerator` (provided) to write three files.

Nothing here is LangGraph-specific to unlearn — it's the same shape as any
Python CLI calling into a pipeline.

### 3.2 Building the one prompt — `src/prompts/orchestrator.prompt.ts`

`buildOrchestratorPrompt(owner, repo, prNumber)` returns a long string. This
string **is the entire control flow** for the review. It literally tells the
model, in English:

1. Use the GitHub MCP tools to fetch PR metadata + changed files.
2. Skip lockfiles/binaries/docs; cap to the 8 biggest diffs.
3. For each file, invoke **all three** subagents by name, in the same turn
   (so they run in parallel), using imperative language ("Use the
   code-quality-analyzer agent to analyze `<path>`...") — **imperative, not
   descriptive**, because the model is much more reliable at actually
   dispatching a tool when told to do it rather than told it "should".
4. If one subagent's call fails, keep going with the other two.
5. Emit one JSON object matching the `ReviewReport` shape, with no
   surrounding prose.

If you wanted to change *when* subagents run, *which* files get skipped, or
*how* failures are handled — you edit this string, not a graph definition.

### 3.3 The orchestrator class — `src/orchestrator.ts`

This is the one and only place `query()` is called
(`CodeReviewOrchestrator.runQuery`). The `options` object passed in is the
entire "wiring diagram":

```ts
const options: Options = {
  model: this.model,                 // never hardcoded — from ANTHROPIC_MODEL
  cwd: this.cwd,                     // must contain .claude/skills/
  maxTurns: this.maxTurns,           // ceiling on total agent turns (default 80)
  permissionMode: 'bypassPermissions', // unattended / CI-style run, no human to approve tool calls
  settingSources: ['project'],       // <- without this, .claude/skills/ is NEVER loaded
  mcpServers: mcpServersConfig,      // github + eslint stdio servers
  agents: {                          // the subagent registry
    'code-quality-analyzer': codeQualityAnalyzer,
    'test-coverage-analyzer': testCoverageAnalyzer,
    'refactoring-suggester': refactoringSuggester
  },
  allowedTools: ['Task', 'Read', 'Grep', 'Glob', 'Skill', 'mcp__github', 'mcp__eslint'],
  outputFormat: { type: 'json_schema', schema: ReviewReportJSONSchema }
};

for await (const message of query({ prompt, options })) {
  // message.type: 'assistant' | 'result' | 'system' | ... — a flat transcript
  if (message.type === 'result') resultMessage = message;
}
```

Think of `query({ prompt, options })` as the one and only "runnable" in this
whole system — everything else is configuration passed into it or
post-processing done on what comes out.

### 3.4 Subagents — `src/agents/*.ts`

Each file exports one `AgentDefinition`:

```ts
export const codeQualityAnalyzer: AgentDefinition = {
  description: 'Use this agent to review a single changed file for security...',
  prompt: CODE_QUALITY_ANALYZER_PROMPT,     // its OWN system prompt
  tools: ['Read', 'Grep', 'Glob', 'Skill', 'mcp__eslint'],  // its OWN tool allowlist
  model: 'inherit'                          // use whatever model the parent used
};
```

The **key** it's registered under (`'code-quality-analyzer'` in
`options.agents`) is the identifier the orchestrator's `Task` tool calls use
(`subagent_type: 'code-quality-analyzer'`). The `description` field is what
the orchestrator model reads to decide *this is the right tool for this
job* — it is doing semantic routing off that string, the same job a
LangGraph conditional-edge function would do explicitly in code, except here
it's the LLM reading English and deciding.

When the orchestrator calls `Task(subagent_type: 'code-quality-analyzer', prompt: '...')`,
the SDK spins up a **separate nested conversation**: new transcript, system
prompt = that agent's `.prompt`, tool access limited to that agent's
`.tools`. It runs its own multi-turn loop (reading the file content it was
given, calling `Skill`, reasoning, etc.) and returns one final answer, which
comes back to the orchestrator as the `tool_result` for that `Task` call.

Useful implementation detail: nested subagent turns aren't hidden from the
outer stream — `SDKAssistantMessage` carries a `parent_tool_use_id` field, so
if you inspect the raw message stream (as
`handleStreamMessage` does, for logging) you can tell which messages belong
to a subagent's inner loop vs. the orchestrator's own turns.

### 3.5 MCP servers — `src/config/mcp.config.ts`

MCP (Model Context Protocol) is a standard for exposing a tool server as a
separate process that talks JSON-RPC over stdio (or HTTP/SSE). It's
conceptually the same job as writing a LangChain `Tool`/toolkit, except the
server is a *separate, reusable, language-agnostic binary* rather than a
Python function you write:

```ts
github: {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '' }
}
```

When this server starts, it advertises a set of tools (e.g. "get pull
request", "list PR files"). The SDK exposes each one to the model as
`mcp__github__<tool-name>`. Listing just `mcp__github` in `allowedTools` is
a prefix-allow — it grants every tool that server advertises, rather than
naming each one individually (useful since MCP servers can add/rename
tools without you having to update your allowlist).

### 3.6 Claude Skills — `.claude/skills/*/SKILL.md`

A Skill is **not** retrieval-augmented generation. There's no embedding, no
similarity search, no vector store. It's a named markdown file
(`security-analysis/SKILL.md`, say) containing domain knowledge. When an
agent's prompt says "invoke Skill 'security-analysis'", the `Skill` tool
call causes the SDK to read that file and inject its full text into the
model's context for that turn — like a dynamically-loaded chunk of system
prompt, looked up by exact name. `settingSources: ['project']` in the
orchestrator's `options` is what makes the SDK look for `.claude/skills/`
under `cwd` at all — easy to forget, and the single most common reason
skills silently don't get used.

### 3.7 Structured outputs — Zod ⇄ JSON Schema ⇄ `structured_output`

1. We define the shape once in Zod (`src/types/analysis-results.ts`,
   `report-types.ts`) — this is your Pydantic model equivalent, with the
   added benefit that Zod schemas are *also* TypeScript types via
   `z.infer<...>`.
2. `zod-to-json-schema(schema, { $refStrategy: 'root' })` converts that into
   plain JSON Schema. The `$refStrategy: 'root'` option matters: by default
   `zod-to-json-schema` emits `$ref`-based definitions, but the SDK's
   structured-output feature needs everything inlined at the root, no
   dangling refs.
3. That JSON Schema goes into `options.outputFormat = { type: 'json_schema', schema }`.
   This is the SDK's equivalent of `llm.with_structured_output(...)` — it
   constrains/guides the model's final answer to match that shape.
4. The terminal message in the `query()` stream (`message.type === 'result'`,
   `message.subtype === 'success'`) carries the parsed object on
   `message.structured_output`.
5. We re-validate it ourselves with `ReviewReportSchema.safeParse(raw)` —
   belt-and-suspenders, because "the SDK tried to constrain the output"
   is not the same guarantee as "the output is valid." `safeParse` (never
   `parse`) so a mismatch becomes a typed `ReviewError` we can report
   cleanly instead of an unhandled exception.

### 3.8 The resilience layer — pure app code, no SDK magic here

`withRetry`, `withTimeout` (`src/utils/error-handler.ts`) and `RateLimiter`
(`src/utils/rate-limiter.ts`) are exactly what they'd be in any Python
service — exponential backoff with jitter, `Promise.race` against a timer,
a sliding 60-second window of request/token counts. The SDK gives you none
of this for free; `reviewPullRequest` composes them explicitly:

```ts
await withTimeout(
  () => withRetry(
    () => withRateLimit(this.rateLimiter, () => this.runQuery(...), ESTIMATED_TOKENS),
    this.maxRetries, 2000
  ),
  this.timeoutMs, '...'
);
```
Outermost timeout bounds the whole operation; retry re-attempts the whole
`query()` call (cheap individual-turn retries aren't exposed by the SDK, so
a "retry" here re-runs the entire multi-agent review); rate limiting gates
how often we're allowed to *start* a review at all.

---

## 4. Where everything lives

| What | File |
|---|---|
| CLI entry point | `src/main.ts` |
| Orchestrator class (`query()` call site) | `src/orchestrator.ts` |
| Orchestrator's system prompt (the "graph" in English) | `src/prompts/orchestrator.prompt.ts` |
| Subagent definitions (tools, model, description) | `src/agents/*.ts` |
| Subagent system prompts | `src/prompts/*-analyzer.prompt.ts`, `refactoring-suggester.prompt.ts` |
| MCP server config (GitHub, ESLint) | `src/config/mcp.config.ts` |
| Claude Skills (domain knowledge files) | `.claude/skills/*/SKILL.md` |
| Zod schemas + generated JSON Schemas | `src/types/analysis-results.ts`, `src/types/report-types.ts` |
| Retry / timeout | `src/utils/error-handler.ts` |
| Rate limiter | `src/utils/rate-limiter.ts` |
| Markdown/HTML/JSON report rendering (provided) | `src/utils/report-generator.ts` |
| Tests | `tests/schemas.test.ts` (Zod schema contracts), `tests/orchestrator.test.ts` (mocks the SDK's `query()` entirely — no network/API key needed to run) |

---

## 5. Things that will trip up a LangGraph instinct

- **You cannot unit-test "the graph."** There is no graph object to invoke
  with a fixture state. The only thing you can deterministically test is
  (a) the Zod schemas, and (b) the orchestrator class with `query()` itself
  mocked (see `tests/orchestrator.test.ts`) — you're testing "did we pass
  the right configuration in and parse the output correctly," not "did the
  model make the right decisions." Whether the model actually dispatches
  all three subagents, in parallel, per file, is a prompt-quality question
  you can only verify empirically (a real run against real credentials),
  not in a unit test.
- **"Parallel" subagents aren't `asyncio.gather`.** The orchestrator prompt
  *asks* the model to issue all three `Task` calls in one turn; whether that
  happens is the model's choice, steered by instruction wording ("issue all
  three Task calls in the SAME message/turn"), not a `Promise.all` we wrote.
- **Retries re-run the whole conversation**, not a single failed tool call.
  There's no per-node checkpointing like LangGraph's persistence layer —
  `withRetry` here throws away the entire prior attempt's transcript and
  starts the orchestrator from scratch.
- **State doesn't persist between our function calls** the way a LangGraph
  `State` dict does across nodes. The "state" for one review is entirely
  inside the SDK's own conversation during that single `query()` call; once
  it returns, all we keep is the one JSON object it produced.

---

## 6. A design question that got settled empirically

The subagents only have `Read`/`Grep`/`Glob` — tools that see the **local
filesystem**, not GitHub. For them to analyze a PR's changed files, the
orchestrator prompt tells the orchestrator to fetch each file's content via
the GitHub MCP server and paste it inline into the `Task` call's prompt
text, rather than having subagents fetch content themselves.

This worked on the first live run against all three required PRs
(`udacity/cd14715-simple-todo-app` #1-3) — no fallback (local PR checkout,
or giving subagents their own GitHub tools) was needed. See `plan.md` §11
for the actual results.

A different failure mode showed up instead, one no amount of static
review would have caught: on the first run of PR #3, the
`test-coverage-analyzer` subagent quietly degraded into English prose
descriptions of what a test *should* do instead of writing the test,
for every one of the 14 untested paths in that file — plausibly because
that file had more untested paths than #1 or #2 and the model got terser
under length pressure partway through a long JSON array. The schema
still validated (`suggestedTest` is typed as `string`, so "Test rejection
of card numbers with less than 16 digits..." is a perfectly valid
string) — this is exactly the class of bug §5 above warns about: **you
cannot catch a subagent's semantic drift with a unit test**, only by
reading real output. The fix was adding a concrete wrong/right example
and a hard syntactic rule to the prompt
(`src/prompts/test-coverage-analyzer.prompt.ts`), then re-running; the
second run produced real `describe`/`it`/`expect` code for all 21
untested paths it found.
