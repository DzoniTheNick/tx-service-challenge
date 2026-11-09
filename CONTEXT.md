# CONTEXT.md — Enterprise AI Assistant (Cloudflare coding challenge)

Read this whole file before writing code. It is the source of truth for scope,
architecture and decisions. If something here conflicts with a request, ask.

## 0. Working mode: MVP first

Build the **minimum that satisfies the brief** first (sections 1–14). Anything in
section 15 (Stretch backlog) is only started after all 8 scenarios pass (the brief's 7 plus
the added HR→IT→HR chain) and the README exists, and only when the user asks for it. Do not
build stretch items early.

### Decisions log

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                | Status  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| D1  | Model: **keyless default** Workers AI `@cf/zai-org/glm-4.7-flash` for all agents (cheap, confirmed multi-turn tool calling, 131k context, no secrets). **Documented fallback** `gpt-6-luna` (OpenAI) for the live scenario runs if glm proves unreliable at tool calling; `gemini-3.8-flash` is the documented alternative. Per-role swap via `MODEL_ORCHESTRATOR` / `MODEL_SPECIALIST`. See section 9. | Decided |
| D2  | `reset_password`: MVP is a mock native tool, `it_admin` + IT agent only, no approval. Full human-in-the-loop flow is stretch S1.                                                                                                                                                                                                                                                                        | Decided |
| D3  | MCP failure mode: `MCP_MODE` env var on the MCP Worker (restart to switch). Runtime toggle is stretch S2.                                                                                                                                                                                                                                                                                               | Decided |
| D4  | No cross-session memory. Specialist history is per session, per agent; the last few tasks of that agent in the same session go into its context.                                                                                                                                                                                                                                                        | Decided |
| D5  | Specialist structured output via a `submit_result` tool (see 3.2).                                                                                                                                                                                                                                                                                                                                      | Decided |
| D6  | **Deployment: local by default.** The MVP is built, run and judged locally via `yarn dev`; the 7 (now 8) demonstration scenarios are all judged locally. A production Cloudflare deployment is an **opt-in path**, not part of the MVP, and is not built unless the user asks.                                                                                                                          | Decided |
| D7  | **Production deployment is specified separately in `PRODUCTION.md`** (design/outline only — Cloudflare Access auth, MCP via service binding, `env.production`, remote KV seeding, GitHub repo + CI/CD, scoped API token). Nothing in it is implemented during the MVP.                                                                                                                                  | Decided |

## 0a. Deployment: local by default

The MVP is run, demonstrated and **judged locally**. The brief says local execution is
sufficient. A production Cloudflare deployment is an **opt-in path** specified separately in
`PRODUCTION.md` (design/outline only); none of it is built during the MVP. Everything below in
this section describes the **local** setup, which is the only thing we build now.

- **Never run `wrangler deploy`** or create remote Cloudflare resources (no
  `wrangler kv namespace create`, `wrangler d1 create`, `wrangler r2 bucket create`,
  `wrangler secret put`). Keep the starter's `deploy` script but do not use it, and note in
  the README that deployment is out of scope.
- **Runtime**: `yarn dev` runs the app Worker in workerd through `@cloudflare/vite-plugin`
  (default `http://localhost:5173`). The MCP Worker runs with `yarn workspace mcp-server dev`
  (`wrangler dev --port 8788`). `yarn dev:all` starts both. `MCP_URL` defaults to
  `http://localhost:8788/mcp`.
- **Local simulation**: Durable Objects + SQLite and KV are simulated by Wrangler/Miniflare
  and persisted in `.wrangler/state` (gitignored). Bindings that need an `id` in
  `wrangler.jsonc` (e.g. the `SKILLS` KV namespace) use a placeholder id; it is never
  created remotely.
- **Seeding**: `scripts/seed-skills.ts` writes to the **local** KV only (e.g.
  `yarn wrangler kv bulk put --binding SKILLS --local <file>`), run via `yarn seed`.
  `yarn dev` should run the seed automatically or the README must say to run it first.
- **The only remote call is the LLM.** The `AI` binding keeps `"remote": true` because
  Workers AI models only run on Cloudflare's GPUs. This needs a free Cloudflare account
  and `yarn wrangler login` once. No other Cloudflare account resources are used.
- **Secrets/config**: `.dev.vars` (gitignored) with a committed `.dev.vars.example`.
  No secrets are required for the default Workers AI setup.
- **Clean demo state**: `yarn reset` deletes `.wrangler/state` and re-seeds, so scenario
  runs start from a known state.
- **Tests** run fully offline with `@cloudflare/vitest-pool-workers` and the fake LLM.
- README setup must be: install Node 20+, `corepack enable`, `yarn install`,
  `yarn wrangler login`, `yarn seed`, `yarn dev:all`, open the local URL.

## 1. The challenge (summary of the brief)

Build a small AI assistant for first-level **IT and HR** questions on **Cloudflare**.
Timebox: **8 hours**. AI-assisted development is encouraged. Deliver runnable source
plus a ~1-page README.

**Exactly three agents**

- **Orchestrator**: receives every user message, delegates to specialists, asks
  follow-up questions, writes the final response. It is the only user-facing agent.
- **IT specialist**: technical questions and basic troubleshooting.
- **HR specialist**: employee processes and company policies.
- Specialists return results **only to the orchestrator**. Each agent has its own
  instructions, its own message history and its own capabilities.

**Orchestration must**

- Delegate to the right specialist.
- Run **independent** specialist tasks **concurrently**.
- Run **dependent** tasks **sequentially**, passing results explicitly.
- Combine contributions into **one coherent response**.
- Be honest about missing information, unavailable capabilities and failures.
- Keep execution bounded (step limits, timeouts).

**Three mechanisms**

- **Native tool**: an app function with validated inputs and a useful result.
- **MCP**: one real client/server connection where an agent _discovers_ and _invokes_ tools.
- **Skill**: a separately stored instruction package. Agents see only name + description;
  full text is loaded **on demand**. Must demonstrate one run where it is loaded and applied.

**Users and permissions**

- Two predefined roles with meaningfully different permissions (a user switcher is enough).
- Distinguish **what the user may do** from **what each agent may do**.
- At least one capability for one role but not the other, and one for one agent but not the other.
- Expose only capabilities permitted for **both** the user and the executing agent.
- Delegation preserves the user's permissions. Agents never offer what they can't do.

**UI, state, trace**

- React chat UI: send/receive, session context, work-in-progress indicator, clear errors
  and capability limits.
- Structured execution trace (no private reasoning, no credentials) covering delegation
  and completion, skill loading, tool calls and outcomes, permission decisions,
  **with timestamps** so concurrency is verifiable. Logs or API response are fine.

**Tech**: strict TypeScript, React, Cloudflare backend, LLM API with tool calling, MCP,
automated tests. Document the model used and configuration needed.

**Priority if short on time**: permissions + orchestration → MCP + skill → UI + trace.

### Demonstration scenarios (real app, real LLM; judge the trace, not the wording)

| #   | Scenario                                                                                 | Expected                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | IT support question                                                                      | IT delegation, skill loading, native tool use                                                                                                                                                                                                                                |
| 2   | Fictional HR policy question                                                             | HR delegation, MCP-backed retrieval                                                                                                                                                                                                                                          |
| 3   | Independent IT + HR questions in one request                                             | Concurrent execution, combined response                                                                                                                                                                                                                                      |
| 4   | IT recommendation depending on an HR result                                              | Sequential, explicit result passing (HR equipment profile → IT setup)                                                                                                                                                                                                        |
| 5   | User requests a capability their role lacks (password reset)                             | Not exposed to any agent; orchestrator explains                                                                                                                                                                                                                              |
| 6   | Specialist delegated a task needing a capability it lacks (HR asked to reset a password) | Not exposed to that specialist; it reports the limitation back                                                                                                                                                                                                               |
| 7   | MCP server in failure mode                                                               | Orchestrator explains the limitation, never claims success                                                                                                                                                                                                                   |
| 8   | Upgrade existing equipment (extra, beyond the brief's seven)                             | Three-hop sequential chain HR→IT→HR: HR returns the current equipment profile, IT recommends an upgrade, HR validates it against policy/budget; explicit result passing at each hop                                                                                          |
| 9   | Leave-request lifecycle across roles (extra)                                             | Cross-user shared state: an employee submits a leave request (pending) → an HR admin (`hr_admin`, e.g. Charlie) approves it by id → the original employee checks the now-approved status. `approve_leave_request` is HR-admin-only; an employee sees only their own requests |

Scenarios 1–7 are the brief's required set; scenarios 8 and 9 are additional demonstrations
(a longer dependency chain, and cross-user stateful workflow). "MVP done" = all pass on a
clean `.wrangler/state`.

**Clarification turns are a success, not a failure.** When the orchestrator asks the user a
follow-up question instead of delegating (because the request is ambiguous or
under-specified), that turn is a **successful outcome** with its own trace event
(`clarification_requested`), never counted as a failed turn or an error.

## 2. Starting point: `cloudflare/agents-starter`

This repo is a clone of the starter. Current state:

- `src/server.ts`: `ChatAgent extends AIChatAgent<Env>` with `maxPersistedMessages = 100`,
  `chatRecovery = true`, `waitForMcpConnections = true`, MCP OAuth callback, `@callable()`
  `addServer` / `removeServer`, `pruneMessages`, `stopWhen: stepCountIs(20)`.
  Demo tools: `getWeather` (server), `getUserTimezone` (client), `calculate`
  (`needsApproval`), scheduling tools.
- Model: Workers AI via `workers-ai-provider`, `@cf/moonshotai/kimi-k2.7-code`.
- `src/app.tsx` (~1000 lines): `useAgent` + `useAgentChat` UI with streaming, tool cards,
  approval buttons, debug toggle, MCP panel, toasts, theme toggle, image upload.
- `wrangler.jsonc`: `nodejs_compat`, `"ai": { "binding": "AI", "remote": true }`,
  static assets with `run_worker_first: ["/agents/*", "/oauth/*"]`, SQLite DO migration.
- Stack versions: `agents ^0.17`, `@cloudflare/ai-chat ^0.9`, `ai ^6`, `zod ^4`,
  React 19, Vite 8 + `@cloudflare/vite-plugin`, TypeScript 6, wrangler 4, oxlint/oxfmt.
- **No tests.** Vitest must be added.

**Keep**: Vite/Wrangler setup, `AIChatAgent` (persistence, recovery, pruning),
`useAgentChat`, AI binding, the `needsApproval` pattern, tool-card rendering, debug toggle.
**Remove**: weather, timezone, calculator, scheduling tools; runtime `addServer` /
`removeServer` and the "add MCP server" UI (MCP is fixed config, not user-supplied — a
security decision worth stating in the README); image upload.

Before using any Agents SDK / AI SDK API, check the installed version's types or the
Cloudflare docs (https://developers.cloudflare.com/agents/). Do not rely on memory for
API names — these packages change quickly.

## 2a. Tooling decisions: Yarn + Hono

**Package manager: Yarn 4 (Berry), not npm.**

- Enable with Corepack: `corepack enable && yarn set version stable`. This adds
  `"packageManager": "yarn@4.x"` to `package.json` and creates `.yarnrc.yml`.
- In `.yarnrc.yml` set `nodeLinker: node-modules`. Wrangler, workerd, Vite and
  `@cloudflare/vitest-pool-workers` expect a real `node_modules`; Plug'n'Play causes
  resolution problems with them.
- Delete `package-lock.json`, run `yarn install`, commit `yarn.lock`.
- The starter's `allowScripts` block in `package.json` is npm-specific. Remove it. Yarn 4
  runs install scripts by default; if `enableScripts: false` is ever set, allow
  `workerd`, `esbuild`, `sharp` via `dependenciesMeta.<pkg>.built: true`.
- Use **Yarn workspaces** for the second Worker: root `package.json` gets
  `"workspaces": ["mcp-server"]`, so one `yarn install` covers both.
- Commands everywhere (scripts, README, docs): `yarn dev`, `yarn test`, `yarn add <pkg>`,
  `yarn add -D <pkg>`, `yarn workspace mcp-server dev`. Root script `dev:all` runs both
  Workers (e.g. with `concurrently`).
- `.gitignore`: add `.yarn/*` with the usual exceptions (`!.yarn/releases`,
  `!.yarn/plugins`, `!.yarn/patches`), plus `.wrangler/` and `.dev.vars`.

**HTTP framework: Hono** (`yarn add hono`) in the app Worker.

- `src/server.ts` exports a Hono app typed with `Hono<{ Bindings: Env; Variables: { user: User } }>`
  as the default export, and still exports the Durable Object classes.
- Middleware: identity (resolve `X-User` header, or `user` query param for WebSocket
  upgrades, against the fixed user list; 401 otherwise) and session ownership check.
- Routes: `GET /api/me`, `GET /api/sessions/:id/trace`, `GET /api/mcp/status`.
- Agents: `app.all("/agents/*", ...)` validates identity/ownership, then calls
  `routeAgentRequest(c.req.raw, c.env)`; return 404 if it returns null.
- Keep `run_worker_first: ["/agents/*", "/api/*"]` in `wrangler.jsonc` so the Worker,
  not static assets, handles these paths. Drop `/oauth/*` (no runtime MCP OAuth).
- Validate request input with Zod (`@hono/zod-validator` is fine).
- The MCP Worker can stay a plain `McpAgent` export; Hono is optional there.

## 3. Architecture

```
React UI (user switcher, chat, trace panel)
   │ WebSocket / HTTP, header X-User
   ▼
App Worker (Hono)  ── identity + session ownership check, /api/*, routeAgentRequest
   │ instance name = `${userId}:${sessionId}` (server-derived, never from the message)
   ▼
Orchestrator Durable Object (AIChatAgent, SQLite)
   ├─ LLM tool: `delegate` (task graph)  ──► Executor (pure TS)
   │                                          ├─ waves via Promise.all
   │                                          ├─ result injection for dependsOn
   │                                          └─ runSpecialist(agent, task, user)
   │                                               ├─ allowedTools(user, agent)
   │                                               ├─ own prompt + own history (SQLite)
   │                                               ├─ generateText, step limit, AbortSignal timeout
   │                                               └─ returns SpecialistResult
   ├─ Native tools: get_service_status, reset_password (mock)
   ├─ Skills: index in prompt, load_skill(name) on demand
   ├─ MCP client ──────────────► MCP Worker (McpAgent, separate Worker)
   │                               policy files + equipment profiles + IT KB
   │                               MCP_MODE = ok | error | timeout
   └─ Trace: SQLite table + JSON console logs
```

**Principle: the LLM decides, code enforces.** The LLM plans and writes. Code owns
permissions, ordering, concurrency, limits, failure handling and the trace.

### 3.1 Delegation: plan-then-execute

The orchestrator LLM has one delegation tool:

```ts
delegate({
  tasks: Array<{
    id: string; // "hr1", "it1"
    agent: "it" | "hr";
    instruction: string; // self-contained; specialists never see the user chat
    dependsOn?: string[];
  }>
}); // max 4 tasks
```

Executor (no LLM):

1. Validate with Zod: known agents, unique ids, existing deps, **no cycles**, ≤ 4 tasks.
2. Compute waves (topological levels). Run each wave with `Promise.all`.
3. For dependent tasks, inject `inputs: { [depId]: SpecialistResult }` into the task and
   emit `result_passed`.
4. Catch every error per task → `status: "failed"` with a reason. One failure never
   aborts the turn. A failed dependency marks dependents `failed: "dependency_failed"`.
5. Return all results to the orchestrator as the tool result.
6. **Deterministic guard**: if every task failed, code appends a fixed notice so the
   final answer cannot claim success.

The orchestrator may also: ask a follow-up **clarification question** instead of delegating,
or decline directly when the user lacks a capability (its prompt lists the user's denied
capabilities). A clarification question is a **successful** turn outcome — the executor is
never invoked, the turn emits a `clarification_requested` trace event and ends normally. It is
not an error and must not trip the all-failed guard.

### 3.2 Specialist result contract

```ts
type SpecialistResult = {
  taskId: string;
  agent: "it" | "hr";
  status: "ok" | "partial" | "failed";
  answer: string;
  data?: Record<string, unknown>; // structured output, e.g. equipment profile
  limitations: string[]; // e.g. "password reset is not available to HR"
  toolErrors: string[];
};
```

Specialists produce this by calling a **`submit_result` tool** whose input schema is
`SpecialistResult`. Loop: `stopWhen: [hasToolCall("submit_result"), stepCountIs(5)]`.
If the loop ends without it (step limit, timeout, plain text answer), the runner wraps
the text as `{ status: "partial", limitations: ["specialist did not return a structured result"] }`.
Invalid `submit_result` input is returned to the model once as a validation error.

**Pinned cross-agent data contract.** When a task result feeds a dependent task, the carried
payload is a _typed_ structure in `data`, not prose, so the weak model on the receiving side
gets structured input. The canonical shape is the equipment profile (shared Zod schema, used by
scenarios 4 and 8):

```ts
type EquipmentProfile = {
  role: string; // e.g. "engineer"
  laptop: { model: string; specs: string };
  accessories: string[];
  software: string[];
  source: { policyId?: string; version?: string }; // provenance for honesty
};
```

The orchestrator passes a producer's `data` to a dependent task verbatim as
`inputs: { [depId]: SpecialistResult }` (see 3.1, step 3). Scenario 8's HR→IT→HR chain uses
this twice: HR emits an `EquipmentProfile`, IT consumes it and emits an upgrade recommendation
in `data`, and HR consumes that to validate against policy/budget.

### 3.3 Limits

- Specialist: max 5 steps, 25 s timeout (AbortSignal).
- Orchestrator: max 6 steps.
- MCP calls: 5 s client timeout.
- Plan: max 4 tasks.
  Keep these in one `config.ts`.

## 4. Permission model

Single pure function, unit-tested:

```ts
allowedTools(user: User, agent: AgentId, all: ToolDescriptor[]): {
  allowed: ToolDescriptor[];
  denied: { name: string; reason: "user_role" | "agent_scope" }[];
}
```

Each tool descriptor declares `roles: Role[]` and `agents: AgentId[]`. A tool is exposed
only if `user.role ∈ roles && agent ∈ agents`. Applied to native tools, `load_skill`
and **MCP tools after discovery** (discovery never bypasses permissions). Every decision
emits a `permission_check` trace event.

### Roles (test users)

| User id | Role       | Description      |
| ------- | ---------- | ---------------- |
| `alice` | `employee` | Regular employee |
| `bob`   | `it_admin` | IT administrator |

### Capability matrix

| Capability                                  | Kind   | employee | it_admin | IT agent | HR agent |
| ------------------------------------------- | ------ | -------- | -------- | -------- | -------- |
| `get_service_status`                        | native | ✓        | ✓        | ✓        | ✗        |
| `reset_password` (mock, no approval in MVP) | native | ✗        | ✓        | ✓        | ✗        |
| `load_skill` (agent-scoped skills)          | native | ✓        | ✓        | ✓        | ✓        |
| `search_policies`                           | MCP    | ✓        | ✓        | ✗        | ✓        |
| `read_policy`                               | MCP    | ✓        | ✓        | ✗        | ✓        |
| `get_equipment_profile`                     | MCP    | ✓        | ✓        | ✗        | ✓        |
| `search_it_kb`                              | MCP    | ✓        | ✓        | ✓        | ✗        |

- User-level difference: `reset_password` (it_admin only).
- Agent-level difference: policy tools (HR only) vs `get_service_status` (IT only).
- Scenario 5: alice asks for a password reset → no agent has the tool → orchestrator explains.
- Scenario 6: "Ask HR to reset my password" → HR has no reset tool → HR returns a limitation.
  Also cover with an executor unit test using a fixed plan, since routing may vary.

### Identity rules

- The Worker resolves the user from `X-User` (or a query param for the WebSocket) against
  the fixed user list. Unknown user → 401.
- Role is bound to the session at creation and stored in SQLite. Switching user in the UI
  starts a new session; a session never changes role.
- The role is never read from message text or chosen by the model.

## 5. MCP server (`mcp-server/`, separate Worker)

- Built with `McpAgent`. Runs on its own port in dev (e.g. `:8788`); app reads `MCP_URL`.
- Fixtures: `policies/*.md` with frontmatter (`id`, `title`, `tags`, `version`,
  `lastUpdated`), e.g. `remote-work.md`, `annual-leave.md`, `equipment.md`,
  `onboarding.md`; `equipment-profiles.json` (role → laptop, accessories, software);
  `it-kb.json` (short troubleshooting articles). All fictional company "Acme d.o.o.".
- Tools: `search_policies(query)` (keyword + tag match, returns id/title/snippet),
  `read_policy(id)` (full text + version), `get_equipment_profile(role)`,
  `search_it_kb(query)`. All inputs validated with Zod. Results are JSON with `ok` flag.
- Optional: expose policies as MCP resources `policy://<id>`.
- `MCP_MODE` env var: `ok` (default) | `error` (tools return `{ ok:false, error }` /
  protocol error) | `timeout` (sleep past the client timeout). Document how to switch.
- Orchestrator DO connects in `onStart()` from config; no runtime server management.
- **Startup must degrade gracefully (scenario 7).** A connect/discovery failure or an MCP
  server in `error`/`timeout` mode must **never block or crash the DO**. The connection attempt
  is wrapped (caught + bounded by the 5 s timeout); on failure the MCP tools are simply absent
  from discovery and the orchestrator still runs and answers honestly ("policy lookup is
  currently unavailable"), never claiming success. Do **not** rely on the starter's
  `waitForMcpConnections = true` to hold startup — set it so a dead MCP server cannot wedge the
  agent, and treat "MCP unavailable" as a first-class, traced state (`mcp_discovery` with an
  error outcome), not an exception thrown across the turn.

## 6. Skills

- Stored as Markdown in `skills/<name>/SKILL.md` with frontmatter:
  `name`, `description`, `agents: [it]`.
- Seed (three skills — IT and HR, to prove the mechanism is not IT-only):
  - `skills/troubleshooting/SKILL.md` — `agents: [it]` (structured diagnose → check status →
    steps → escalate). Required skill demo for scenario 1.
  - `skills/device-setup/SKILL.md` — `agents: [it]` (new-device setup checklist; used in
    scenarios 4 and 8).
  - `skills/leave-request-process/SKILL.md` — `agents: [hr]` (HR leave-request procedure).
    Demonstrates an HR-scoped skill loading and applying, symmetric to the IT skills.
- Loading: **KV namespace `SKILLS` is the source of truth**, seeded by
  `scripts/seed-skills.ts`. A bundled `import` of the same Markdown is the **documented
  fallback** only (if KV seeding is unavailable); KV is canonical and what the scenarios use.
  Specialist prompt contains only the index (name + description) of skills allowed for that
  agent. `load_skill(name)` returns the body and emits `skill_loaded`. Prompts instruct: load a
  relevant skill before answering and follow it.
- **Per-skill scoping is by the `agents` frontmatter**, enforced in two places using the same
  field: (1) the index filter — each specialist only _sees_ skills whose `agents` include its
  id; (2) the `load_skill` server check — it only _loads_ a skill scoped to the calling agent.
  The `load_skill` tool itself is granted to both agents in the capability matrix; the
  frontmatter is what differentiates IT vs HR skills.
- Never paste skill bodies into system prompts.

## 7. State and trace

All in the orchestrator DO's SQLite (persists in `.wrangler/state` locally):

- Orchestrator chat: handled by `AIChatAgent`.
- `session(user_id, role, created_at, model_config)`.
- `agent_messages(id, agent, task_id, role, content, ts)` — specialist histories.
- `trace(id, ts, turn_id, agent, event, detail_json)`.

**Turn model.** One inbound user message = one **turn**. The `turn_id` is minted **server-side**
when the message is received (never from the client or message text) and stamped on every trace
row for that turn. This is what makes concurrency verifiable — all events sharing a `turn_id`
are grouped, and overlapping `specialist_start`/`specialist_end` timestamps within one turn prove
parallel execution. It also gives a clean per-turn slice for debugging.

Never keep durable data in class fields (lost on eviction).

Trace events: `permission_resolved`, `delegation_planned`, `clarification_requested`,
`specialist_start`, `permission_check`, `skill_loaded`, `tool_call` (name, ok/error,
duration_ms), `mcp_discovery` (ok/error outcome), `result_passed`, `specialist_end` (status),
`guard_applied`, `turn_end`. `clarification_requested` marks a successful follow-up-question
turn (see 3.1); `mcp_discovery` with an error outcome marks graceful MCP degradation (see 5).
Timestamps: ISO with milliseconds. Each event also `console.log(JSON.stringify(e))`.
Never log credentials, API keys or model reasoning.

`GET /api/sessions/:id/trace` returns the trace (checked against the requesting user).

## 8. UI changes (`src/app.tsx`)

- User dropdown (alice / bob) → new session per user.
- Keep streaming, tool cards, approval buttons, debug toggle, stop, clear.
- Replace the MCP panel with a read-only status (connected, tool count, current mode).
- Error banner for failed turns and connection errors.
- Collapsible trace panel fetching `/api/sessions/:id/trace` (lowest priority).

## 9. Model configuration

- `LlmClient` boundary so models are config: `MODEL_ORCHESTRATOR`, `MODEL_SPECIALIST` (per-role,
  so the orchestrator can run a stronger model than the specialists).
- **Keyless default**: Workers AI `@cf/zai-org/glm-4.7-flash` for orchestrator and specialists
  (no key, `yarn wrangler login`; free 10,000 Neurons/day; a fresh clone runs with zero secrets,
  and the offline test suite uses the fake `LlmClient` so it needs no key regardless). **Verify
  one tool-call round trip in Phase 0** before building on it.
- **Documented fallback** (used for the live scenario runs _only if_ glm proves unreliable at
  `delegate`/`submit_result` in the Phase-0 smoke test): `gpt-6-luna` (OpenAI) — newest-generation
  small model, cheap ($0.10/$0.50 per 1M in/out), strong function calling; **`gemini-3.8-flash`**
  is the documented alternative. Both need an API key in `.dev.vars` (gitignored), which is why
  they are a fallback, not the default. Optionally route them through **Cloudflare AI Gateway** to
  keep everything on Cloudflare and add caching/observability.
- Model prices and ids were verified against the providers' official pricing pages (Nov 2026);
  re-check before a run. Document the exact model used for the scenario runs in the README.

## 10. Target layout

```
src/
  server.ts               # Hono app + routeAgentRequest, exports DO classes
  config.ts               # limits, model names
  identity.ts             # users, roles, session ownership
  agents/orchestrator.ts  # AIChatAgent subclass, delegate tool, prompts
  agents/specialists.ts   # runSpecialist, IT/HR prompts
  orchestration/executor.ts
  orchestration/plan.ts   # Zod plan schema, wave computation, cycle check
  permissions/registry.ts # tool descriptors, roles, agent scopes
  permissions/allowed.ts  # allowedTools()
  tools/native.ts         # get_service_status, reset_password
  skills/loader.ts        # index + load_skill
  mcp/client.ts           # connect, discover, filter, timeout wrapper
  trace.ts
  llm.ts                  # LlmClient + fake for tests
  app.tsx, client.tsx
mcp-server/
  src/index.ts, wrangler.jsonc, fixtures/
skills/troubleshooting/SKILL.md     # agents: [it]
skills/device-setup/SKILL.md        # agents: [it]
skills/leave-request-process/SKILL.md  # agents: [hr]
scripts/seed-skills.ts
test/                     # Vitest, @cloudflare/vitest-pool-workers
docs/scenarios/           # prompt + observed trace per scenario (1–8)
README.md
PRODUCTION.md             # opt-in production deployment design (outline only; not MVP)
```

## 11. Build plan (8 h)

| Phase | Time | Work                                                                                                                                                                    | Done when                                                                                          |
| ----- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0     | 0:30 | Switch to Yarn 4 + workspaces, add Hono, restructure starter, strip demo tools, add Vitest + workers pool, add mcp-server Worker skeleton, **LLM tool-call smoke test** | `yarn dev` + `yarn test` run                                                                       |
| 1     | 0:45 | Permission registry, `allowedTools`, identity, trace emitter                                                                                                            | Unit tests for both permission differences pass                                                    |
| 2     | 1:00 | `LlmClient` + fake, `runSpecialist`, native tools, result contract                                                                                                      | Specialist tests (ok / denied tool / timeout) pass                                                 |
| 3     | 1:15 | Orchestrator DO, `delegate`, executor, guard, Hono routing                                                                                                              | Executor tests (parallel timing, dependency passing, failure propagation); scenarios 3–6 work live |
| 4     | 1:00 | MCP server + fixtures + `MCP_MODE`, client discovery + filter + timeout                                                                                                 | Scenarios 2 and 7                                                                                  |
| 5     | 0:30 | Skills + `load_skill` + KV seed                                                                                                                                         | Scenario 1                                                                                         |
| 6     | 1:15 | UI: user switcher, errors, MCP status, trace endpoint/panel                                                                                                             | Manual run of all scenarios in UI                                                                  |
| 7     | 1:15 | Run 7 scenarios on clean `.wrangler/state`, save to `docs/scenarios/`, write README                                                                                     | Deliverables complete                                                                              |

**Phase-0 verification checklist** (confirm these before building on them):

1. **LLM tool-call round trip** — glm-4.7-flash emits a valid `delegate`/`submit_result` tool
   call. If it flakes, switch to the `gpt-6-luna` fallback (§9).
2. **AbortSignal → LLM** — the installed `workers-ai-provider` is new enough to forward
   `abortSignal` into `env.AI.run()` (older versions reject the wrapper while the binding call
   keeps running and burning neurons). Pin an adequate version.
3. **AbortSignal/timeout → MCP** — the agents-SDK MCP client surface exposes per-call
   `timeout`/`signal` passthrough, so the 5 s MCP timeout genuinely cancels the call
   (`notifications/cancelled`), not just a local reject.
4. **Fallback model capability** — if using `gpt-6-luna`, confirm function-calling support on the
   provider's Models page (the pricing page does not assert it).

**Cut order if behind**: trace panel (keep API) → streaming polish → KV (bundle skills)
→ extra tests. **Never cut** permission tests or executor tests.

## 12. Testing

- Vitest with `@cloudflare/vitest-pool-workers` (tests run in workerd).
- All unit/integration tests use a **fake LlmClient** (scripted tool calls). Only the 7
  scenario runs use a real model.
- Must-have tests: `allowedTools` matrix; plan validation (cycles, unknown agent, limits);
  wave execution with overlapping timestamps; dependency injection; failure propagation +
  guard; MCP timeout → failed result; skill index excludes bodies; `load_skill` emits trace.

## 13. README must cover (~1 page + setup)

Setup and config, test users, how to run each scenario (all 8, incl. switching `MCP_MODE`),
roles and capabilities table, architecture overview (agents, tools, MCP, skills,
permissions, state, key choices and trade-offs), model used (keyless glm default +
`gpt-6-luna` fallback), how AI tools were used and verified, time spent, known limitations.
State that **deployment is out of scope for the MVP** and point to `PRODUCTION.md` for the
opt-in production path. Next priorities (e.g. Postgres audit log via Hyperdrive, Vectorize
search, R2 skill folders, real identity, Jev-style router).

## 14. Conventions

- Strict TypeScript, no `any`. Zod for every external input (tool args, MCP results, plans, headers).
- Small pure functions for logic that needs tests; DO classes stay thin.
- Errors become typed results, not thrown across agent boundaries.
- Keep a running `NOTES.md` of where AI tools helped and how output was verified.
- Commit at the end of each phase.

## 15. Stretch backlog (not in MVP — only when asked)

- **S1. Password reset with human-in-the-loop.** IT specialist returns
  `status: "needs_approval"`; orchestrator calls client-side tool `collect_new_password`
  → UI password form (≥12 chars, upper, lower, digit, special) → password sent directly to
  the DO via `@callable()`, never as a chat message or to the LLM → server re-validates
  with the same shared Zod schema → pending action stored briefly → model sees only
  `{ ok, masked: "********xasa" }` → `confirm_password_reset` with `needsApproval`:
  "Should we switch the password for <user> to **\*\*\*\***xasa?" → on approve run mock
  reset and delete the secret. Trace: `password_validated`, `approval_requested`,
  `approval_granted|approval_denied`. Never log the password.
- **S2.** Runtime MCP mode toggle (admin endpoint + UI switch).
- **S3.** Executor checkpoint table `turn_tasks` for crash resume; D1 mirror of trace as
  audit log via `ctx.waitUntil()`.
- **S4.** Live progress via `broadcast()` of trace events.
- **S5.** Restricted policy files with sensitivity levels enforced in the MCP server.
- **S6.** Optional Jev-style router behind a `Router` interface.
- **S7.** Opt-in per-user cross-session memory in D1.
