# TX Service — Help Desk

A small **enterprise AI assistant** for first-level **IT and HR** questions, built on
Cloudflare. Three agents — an **orchestrator** (the user-facing assistant) that delegates to an
**IT specialist** and an **HR specialist** — with a real permission model, a native tool, an MCP
integration, on-demand skills, a structured execution trace, and a stateful cross-user leave
workflow. Guiding principle: **the LLM decides, code enforces** (permissions, ordering,
concurrency, limits, failure handling, trace).

The full challenge spec is in `CONTEXT.md`; a production-design sketch (out of MVP scope) in
`PRODUCTION.md`.

---

## Setup & running

### Requirements / configuration

Workers AI has **no local simulator**, so even local dev proxies inference to Cloudflare. You need
Cloudflare credentials:

- A **Cloudflare API token** with **Workers Scripts: Edit + Workers AI** (the dashboard's
  **"Edit Cloudflare Workers"** template, plus the _Workers AI_ permission). An AI-only token is
  **not** enough — local dev creates a remote preview session. Your account must also have a
  **workers.dev subdomain** registered.
- Your **account id**.

No other keys are needed: the default model is keyless Workers AI.

### Option A — Docker (recommended for host-browser testing)

```sh
cp .env.example .env          # then fill CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
docker compose up --build
# open http://localhost:5173
```

Dependencies are installed **inside** the image (correct-platform binaries). `MCP_MODE`
(`ok`|`error`|`timeout`, for scenario 7) is read from `.env`. Note: `.wrangler/state` is ephemeral
in the container, so leave requests reset on rebuild.

### Option B — local

```sh
corepack enable && corepack prepare yarn@4.18.1 --activate
yarn install
# authenticate: export CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN, or `wrangler login`
yarn seed          # seed the skills KV (bundled fallback exists if skipped)
yarn dev:all       # app on :5173, MCP server on :8788
```

### Tests & checks (all offline, no credentials)

```sh
yarn test        # vitest (@cloudflare/vitest-pool-workers, runs in workerd) — 84 tests
yarn typecheck   # tsc (app + mcp-server)
yarn lint        # oxlint
yarn exec oxfmt --check .
yarn exec vite build
```

### Model configuration

Default (keyless): **`@cf/zai-org/glm-4.7-flash`** (Workers AI) for both roles. Override per role
with `MODEL_ORCHESTRATOR` / `MODEL_SPECIALIST` env vars. A faster/stronger fallback
(`gpt-6-luna`) is documented but the provider switch is **not wired yet** (see Limitations).

---

## Users, roles & capabilities

Pick a user from the header switcher (no login — identity is a request header / WS query param).
Switching users starts a fresh chat session.

| User        | Role             | Can do (beyond the shared set)     |
| ----------- | ---------------- | ---------------------------------- |
| **Alice**   | Employee         | shared capabilities only           |
| **Bob**     | IT Administrator | **reset another user's password**  |
| **Charlie** | HR Administrator | **approve pending leave requests** |

**Shared capabilities (all roles):** check IT service status, search the IT knowledge base, look up
company policies, look up role equipment profiles, submit a leave request, check _your own_ leave
requests and PTO balance.

The permission model distinguishes two axes (`src/permissions/registry.ts`):

- **User-level** (role gate): `reset_password` → it_admin only; `approve_leave_request` → hr_admin only.
- **Agent-level** (scope gate): IT-only tools (`get_service_status`, `search_it_kb`) vs HR-only tools
  (`search_policies`, `read_policy`, `get_equipment_profile`, leave tools).

A tool is exposed to a specialist **only if permitted for both the current user and that agent**;
delegation preserves the user's permissions. Agents are transparent about what they can't do and
never offer it.

---

## Demonstration scenarios

Run the real app (real LLM). Judge the **trace** (delegation, skills, tools, permissions), not the
wording. Observed traces per scenario live in `docs/scenarios/`.

| #   | As                      | Prompt                                                                  | Demonstrates                                                   |
| --- | ----------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Alice                   | "The VPN seems to be down — can you check and help?"                    | IT delegation, **skill load**, native tool                     |
| 2   | Alice                   | "What's the remote-work policy?"                                        | HR delegation, **MCP retrieval**                               |
| 3   | Alice                   | "My VPN won't connect, and how many leave days do I get?"               | **Concurrent** IT+HR, combined answer                          |
| 4   | Alice                   | "I'm a new engineer — what equipment do I get, and set it up?"          | **Sequential** HR→IT, result passing                           |
| 5   | Alice                   | "Can you reset my password?"                                            | User lacks capability → **not offered**, explained             |
| 6   | Bob                     | "Have the HR specialist (not IT) reset alice's password."               | Specialist lacks capability (agent scope) → reports limitation |
| 7   | Alice                   | _(set `MCP_MODE=error`)_ "What's the leave policy?"                     | MCP failure → honest limitation, no fabrication                |
| 8   | Alice                   | "I want to upgrade my laptop — what can I get and is it within policy?" | 3-hop HR→IT→HR chain                                           |
| 9   | Alice → Charlie → Alice | submit leave → approve by id → check status                             | **Cross-user stateful** workflow                               |

Scenarios 1–7 are the brief's required set; 8 and 9 are extra. The MCP server's failure mode for
scenario 7 is the `MCP_MODE` switch.

---

## Architecture overview

- **Orchestrator** (`src/agents/orchestrator.ts`) — an `AIChatAgent` Durable Object, one per user
  session. Streams the chat and exposes a single `delegate` tool. It validates the plan
  (`src/orchestration/plan.ts`: schema, dup/cycle/dep checks, wave computation) and runs it through
  the **executor** (`src/orchestration/executor.ts`): independent tasks run concurrently per wave,
  dependent tasks run sequentially with results injected downstream, one failure never aborts the
  turn, and an all-failed guard stops the orchestrator from claiming success.
- **Specialists** (`src/agents/specialists.ts`) — `runSpecialist` runs one delegated task for one
  agent: it filters tools via `allowedTools`, runs a bounded model loop (steps + timeout + retries),
  and returns a typed `SpecialistResult` via a `submit_result` tool (with a free-text fallback).
  Specialists return only to the orchestrator.
- **Tools / MCP / skills** — a **native tool** (`src/tools/*`, Zod-validated); an **MCP server**
  (`mcp-server/`, a separate Worker) the orchestrator connects to, discovers, filters and invokes,
  with a per-call timeout and graceful degradation; **skills** (`skills/*/SKILL.md`) whose name +
  description are shown up front and whose body is loaded on demand via `load_skill`.
- **Permission model** — declarative registry interpreted by one pure `allowedTools(user, agent)`.
- **State** — each chat Durable Object holds its `session` row + per-turn `trace` in SQLite; a
  **separate shared `LeaveStore` Durable Object** holds leave requests so they're visible across
  users (the cross-user workflow). The UI keeps context within an active session.
- **Trace** (`src/trace.ts`) — every step emits a typed row (delegation + completion, skill loading,
  tool calls + outcomes, permission decisions, retries) with ISO-ms timestamps so concurrency is
  verifiable. Readable at `GET /api/sessions/:id/trace` and in the in-app Trace panel.

**Key technical choices / trade-offs:** strict TypeScript (no `any`), Zod for every external input,
small pure functions for the tested logic with thin DO classes, errors as typed results (never
thrown across agent boundaries), and a provider-agnostic `LlmClient` boundary so the model is config.
Hono for HTTP routing; the test stack is pinned to the stable `@cloudflare/vitest-pool-workers@0.8.71`
line (which fixes `vite@7`). `@cloudflare/ai-chat` is pinned to `0.9.3` to match `agents@0.17.4`.

---

## AI-assisted development

Built with **Claude Code** (pair-programming). Output was verified by keeping an **offline gate
green at every step** — `typecheck` + `oxlint` + `oxfmt` + **84 unit tests** (`@cloudflare/vitest-
pool-workers`, running in `workerd`) + `vite build` — and by **live runs** of the scenarios against
the real model. The permission logic, plan/executor (parallel timing, dependency passing, failure
propagation), MCP discovery/degradation, skill scoping, the leave workflow, and the retry policy are
all covered by tests with a scripted fake `LlmClient`, so none need a key or the network.

---

## Time, limitations & next priorities

**Approximate time:** ~1 working day of pairing (the brief's 8h timebox), spread over the phased
build plus extra scope the brief did not require (3rd role, leave workflow, retries, Docker).

**Known limitations:**

- **Latency.** A turn is many sequential remote model calls on glm-4.7-flash, so turns can take
  15–60s. The biggest lever is a faster model — but the `gpt-6-luna`/local-Ollama **provider switch
  is not wired yet**; only the Workers AI provider exists in `src/llm.ts`.
- **Model reliability.** glm occasionally mis-plans, over-asks, or phrases capability answers loosely;
  code enforcement (permissions, status transitions) is correct regardless of wording.
- **Specialists are stateless per task** (the orchestrator holds the session history) — a deliberate
  simplification, not a per-specialist chat history.
- **Clarification detection is heuristic** (a non-delegating turn is treated as a clarification).
- **Docker state is ephemeral** (leave requests reset on rebuild); PTO balances are a static fixture.
- The orchestrator DO class is still named `ChatAgent` (kept for binding/migration stability).

**Next priorities:** wire the `gpt-6-luna`/local provider switch (speed + reliability); strip
remaining starter remnants; persist Docker `.wrangler` state if desired; optionally give specialists
their own message history.
