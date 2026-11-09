# Demonstration scenarios

Each scenario below has the **role to sign in as**, an **example prompt**, **what to look for**,
and the **expected execution trace** (the event sequence the code emits). Judge the _trace_
(delegation, skills, tools, permissions), not the exact wording — responses vary because the model
is real (`@cf/zai-org/glm-4.7-flash`).

> **Status:** the traces below are the _expected_ event sequences produced by the code. To capture a
> live run, see "Capturing a live trace" at the bottom and paste the real rows under each scenario.

**Trace event vocabulary** (from `src/trace.ts`): `permission_resolved`, `mcp_discovery`,
`delegation_planned`, `result_passed`, `specialist_start`, `permission_check`, `skill_loaded`,
`tool_call`, `specialist_retry`, `specialist_end`, `guard_applied`, `clarification_requested`,
`turn_end`. Every row carries a shared per-turn `turnId` and an ISO-ms `ts`, so overlapping
`specialist_start`/`specialist_end` timestamps prove concurrency.

---

## 1 — IT support question (skill + native tool)

**As Alice.** Prompt: _"The VPN seems to be down — can you check and help?"_

**Look for:** delegation to the **IT** agent, a **skill loaded** on demand, a **native tool** call.

```
orchestrator  permission_resolved  {user: alice, role: employee}
orchestrator  mcp_discovery        {ok: true, toolCount: 4, tools: [...]}
orchestrator  delegation_planned   {tasks: [{id, agent: it, dependsOn: []}], waves: [[id]]}
it            specialist_start     {taskId, instruction: "...VPN..."}
it            permission_check     {allowed: [get_service_status, search_it_kb, load_skill, ...],
                                    denied: [{reset_password, user_role}, {HR tools, agent_scope}]}
it            skill_loaded         {taskId, name: troubleshooting}
it            tool_call            {name: get_service_status, ok: true, duration_ms}
it            specialist_end       {taskId, status: ok}
orchestrator  turn_end             {delegated: true}
```

## 2 — Fictional HR policy question (MCP retrieval)

**As Alice.** Prompt: _"What's the remote-work policy?"_

**Look for:** delegation to **HR**, **MCP-backed** retrieval (`search_policies` / `read_policy`).

```
orchestrator  permission_resolved  {user: alice, role: employee}
orchestrator  mcp_discovery        {ok: true, toolCount: 4, tools: [search_policies, read_policy, ...]}
orchestrator  delegation_planned   {tasks: [{id, agent: hr, dependsOn: []}], waves: [[id]]}
hr            specialist_start     {taskId, instruction: "...remote-work policy..."}
hr            permission_check     {allowed: [search_policies, read_policy, get_equipment_profile,
                                    get_leave_requests, get_leave_balance, submit_leave_request, load_skill],
                                    denied: [{IT tools, agent_scope}, {approve_leave_request, user_role}]}
hr            tool_call            {name: search_policies, ok: true}
hr            tool_call            {name: read_policy, ok: true}
hr            specialist_end       {taskId, status: ok}
orchestrator  turn_end             {delegated: true}
```

## 3 — Independent IT + HR in one request (concurrent)

**As Alice.** Prompt: _"My VPN won't connect, and how many leave days do I get?"_

**Look for:** two tasks in **one wave** (parallel). Overlapping `it`/`hr` start–end timestamps prove
concurrency. One combined final answer.

```
orchestrator  delegation_planned   {tasks: [{a, agent: it}, {b, agent: hr}], waves: [[a, b]]}
it            specialist_start     {taskId: a}        ─┐ overlapping timestamps
hr            specialist_start     {taskId: b}        ─┘ (same wave, Promise.all)
it            tool_call / specialist_end  {a, ok}
hr            tool_call / specialist_end  {b, ok}
orchestrator  turn_end             {delegated: true}
```

## 4 — IT depends on an HR result (sequential, result passing)

**As Alice.** Prompt: _"I'm a new engineer — what equipment do I get, and can you set it up?"_

**Look for:** two **waves** (HR then IT), a `result_passed` row injecting HR's equipment profile
into the IT task.

```
orchestrator  delegation_planned   {tasks: [{hr1, agent: hr}, {it1, agent: it, dependsOn: [hr1]}],
                                    waves: [[hr1], [it1]]}
hr            specialist_start / tool_call(get_equipment_profile) / specialist_end  {hr1, ok}
orchestrator  result_passed        {from: hr1, to: it1}
it            specialist_start / specialist_end  {it1, ok}
orchestrator  turn_end             {delegated: true}
```

## 5 — User lacks a capability (password reset)

**As Alice (employee).** Prompt: _"Can you reset my password?"_

**Look for:** `reset_password` is **not exposed to any agent** for this user; the orchestrator
explains it cannot do it. (May be answered directly without delegating, or delegated to IT where the
`permission_check` shows `reset_password` denied `user_role`.)

```
orchestrator  permission_resolved  {user: alice, role: employee}
# direct capability answer (no delegate) → clarification_requested is emitted for a non-delegating turn
orchestrator  clarification_requested  {}
orchestrator  turn_end             {delegated: false}
# OR, if delegated to IT:
it            permission_check     {denied: [{reset_password, user_role}, ...]}
it            specialist_end       {status: partial/failed — reports it cannot}
```

## 6 — Specialist lacks a capability (HR asked to reset a password)

**As Bob (IT admin).** Prompt: _"Have the HR specialist (not IT) reset alice's password."_

> Signed in as **Bob** so the block is clearly **agent scope**, not the user's role (Bob _can_ reset
> via IT). The explicit "HR specialist (not IT)" forces the HR routing.

**Look for:** delegation to **HR**, whose `permission_check` shows `reset_password` **denied
`agent_scope`** (HR never gets the tool), and the specialist reports the limitation back.

```
orchestrator  delegation_planned   {tasks: [{id, agent: hr}], waves: [[id]]}
hr            specialist_start     {taskId, instruction: "...reset alice's password..."}
hr            permission_check     {allowed: [HR tools...],
                                    denied: [{reset_password, agent_scope}, {get_service_status, agent_scope}, ...]}
hr            specialist_end       {taskId, status: partial/failed — "no tool to reset passwords"}
orchestrator  turn_end             {delegated: true}
```

## 7 — MCP integration failure

**As Alice**, with the MCP server in failure mode: set `MCP_MODE=error` (or `timeout`) in `.env` and
`docker compose up --build`. Prompt: _"What's the leave policy?"_

**Look for:** `mcp_discovery` degrades (or MCP `tool_call`s return errors / time out), and the
orchestrator **explains the limitation without claiming success** — no fabricated policy.

```
orchestrator  mcp_discovery        {ok: false, error: "..."}        # error mode: discovery degrades
hr            specialist_start / permission_check
# (no MCP tools exposed) hr reports it cannot retrieve the policy
hr            specialist_end       {status: partial/failed, toolErrors: [...]}  # timeout mode: "mcp_timeout after ...ms"
orchestrator  turn_end             {delegated: true}
```

## 8 — Upgrade existing equipment (3-hop chain) — _extra_

**As Alice.** Prompt: _"I want to upgrade my laptop — what can I get and is it within policy?"_

**Look for:** three waves HR→IT→HR with `result_passed` at each hop.

```
orchestrator  delegation_planned   {tasks: [{hr1}, {it1, dependsOn:[hr1]}, {hr2, dependsOn:[it1]}],
                                    waves: [[hr1], [it1], [hr2]]}
... result_passed hr1→it1 ... result_passed it1→hr2 ... turn_end {delegated: true}
```

## 9 — Leave-request lifecycle (cross-user, stateful) — _extra_

Three turns, switching users (the shared `LeaveStore` Durable Object makes the request visible
across sessions).

1. **As Alice:** _"I'd like to request leave from the 14th to the 23rd of November 2026 for a
   vacation."_ → HR `tool_call {submit_leave_request, ok}`; note the returned **request id**, status
   **pending**.
2. **As Charlie (HR admin):** _"Show pending leave requests."_ → `tool_call {get_leave_requests}` (admin
   sees all). Then _"Approve request <id>."_ → `tool_call {approve_leave_request, ok}` → **approved**.
3. **As Alice:** _"What's the status of my leave request?"_ → `tool_call {get_leave_requests}` (own) →
   **approved**.

**Look for:** `approve_leave_request` appears in Charlie's `permission_check` **allowed** but is
**denied `user_role`** for Alice/Bob; Alice's `get_leave_requests` returns only her own.

---

## Capturing a live trace

1. Run the app (Docker or `yarn dev:all`) and send the prompt in the UI.
2. Flip the **Trace** toggle in the header to watch rows populate, **or** pull them via the API:
   ```sh
   curl -s -H "X-User: alice" \
     "http://localhost:5173/api/sessions/<userId>:<sessionId>/trace" | jq
   ```
   The session instance name is `${userId}:${sessionId}`; the trace API is owner-checked (a user may
   only read their own sessions). Paste the returned rows under the matching scenario above.
