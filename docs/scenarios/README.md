# Demonstration scenarios — observed traces

Each scenario has the **role to sign in as**, an **example prompt**, and the **observed execution
trace** captured from a live run against the real model (`@cf/zai-org/glm-4.7-flash`) on
**2026-11-09**. Judge the _trace_ (delegation, skills, tools, permissions), not the exact wording —
responses and the orchestrator's plans vary run to run because the model is real.

Traces were pulled from `GET /api/sessions/<userId>:<sessionId>/trace` (owner-checked). Rows are
shown as `agent  event  detail`; every row also carries a shared per-turn `turnId` and an ISO-ms
`ts`, so overlapping `specialist_start`/`specialist_end` timestamps prove concurrency. Turns take
~15–40s (glm is slow — see the README's "Latency" note).

> A note on `status: partial`: glm sometimes writes its answer as plain text instead of calling the
> `submit_result` tool. The runner's **free-text fallback** still captures that answer and marks the
> result `partial` — the user still gets a correct reply; it just skipped the structured contract.

---

## 1 — IT support question (skill + native tool) — Alice

_"The VPN seems to be down — can you check and help?"_ — **observed** (turn ≈ 39s):

```
orchestrator  permission_resolved  {user: alice, role: employee}
orchestrator  mcp_discovery        {ok: true, toolCount: 4, tools: [search_policies, read_policy, get_equipment_profile, search_it_kb]}
orchestrator  delegation_planned   {tasks: [{id: vpn-status, agent: it}], waves: [[vpn-status]]}
it            specialist_start     {instruction: "Check the current status of the VPN service and look up troubleshooting steps..."}
it            permission_check     {allowed: [get_service_status, load_skill, search_it_kb],
                                    denied: [reset_password/user_role, search_policies/agent_scope, read_policy/agent_scope,
                                             get_equipment_profile/agent_scope, submit_leave_request/agent_scope,
                                             get_leave_requests/agent_scope, get_leave_balance/agent_scope, approve_leave_request/user_role]}
it            tool_call            {name: get_service_status, ok: true, duration_ms: 2}     ← native tool
it            tool_call            {name: search_it_kb, ok: true, duration_ms: 134}         ← MCP KB
it            skill_loaded         {name: troubleshooting}                                   ← skill loaded on demand
it            tool_call            {name: load_skill, ok: true}
it            specialist_end       {status: ok}
orchestrator  turn_end             {delegated: true}
```

✔ IT delegation · native tool · MCP tool · **skill loaded and applied**.

## 2 — Fictional HR policy question (MCP retrieval) — Alice

_"What's the remote-work policy?"_ — **observed**:

```
orchestrator  mcp_discovery        {ok: true, toolCount: 4, tools: [...]}
orchestrator  delegation_planned   {tasks: [{id: remote-work-policy, agent: hr}], waves: [[remote-work-policy]]}
hr            permission_check     {allowed: [load_skill, search_policies, read_policy, get_equipment_profile,
                                             submit_leave_request, get_leave_requests, get_leave_balance],
                                    denied: [get_service_status/agent_scope, reset_password/user_role,
                                             search_it_kb/agent_scope, approve_leave_request/user_role]}
hr            tool_call            {name: search_policies, ok: true, duration_ms: 70}       ← MCP retrieval
hr            tool_call            {name: read_policy, ok: true, duration_ms: 31}
hr            specialist_end       {status: ok}
orchestrator  turn_end             {delegated: true}
```

✔ HR delegation · MCP-backed retrieval.

## 3 — Independent IT + HR in one request (concurrent) — Alice

_"My VPN won't connect, and how many leave days do I get?"_ — **observed** (note the overlapping
`specialist_start` timestamps → parallel):

```
orchestrator  delegation_planned   {tasks: [{vpn-1, agent: it}, {pto-1, agent: hr}], waves: [[vpn-1, pto-1]]}
it            specialist_start     {vpn-1}   16:31:39.383  ─┐  same wave, Promise.all
hr            specialist_start     {pto-1}   16:31:39.396  ─┘  (12 ms apart)
hr            tool_call            {name: get_leave_balance, ok: true}   16:31:41.951   ┐ interleaved
it            tool_call            {name: get_service_status, ok: true}  16:31:42.363   ┘
hr            specialist_end       {pto-1, status: partial}
it            specialist_end       {vpn-1, status: partial}
orchestrator  turn_end             {delegated: true}
```

✔ One wave, two agents, overlapping timestamps = **concurrent execution**; combined final answer.

## 4 — IT recommendation depending on an HR result (sequential) — Alice

_"I'm a new engineer — what equipment do I get, and set it up?"_

> **Run-to-run variance.** The sequential-with-result-passing mechanism is proven live in **scenario
> 9 turn 2** below (`waves: [[list_pending], [approve_alice]]` with `dependsOn`). For this specific
> prompt, glm's routing was inconsistent in our runs (it sometimes put the HR-scoped
> `get_equipment_profile` on the IT agent, which then failed honestly — `it specialist_end
{status: failed}` — a correct "capability not available" outcome, just not the intended chain).
> Expected clean trace:
>
> ```
> delegation_planned {tasks: [{hr1, agent: hr}, {it1, agent: it, dependsOn: [hr1]}], waves: [[hr1], [it1]]}
> hr  tool_call {get_equipment_profile, ok}  →  hr specialist_end {ok}
> orchestrator result_passed {from: hr1, to: it1}
> it  specialist_end {ok}
> ```

## 5 — User lacks a capability (employee password reset) — Alice

_"Can you reset my password?"_ — **observed**:

```
orchestrator  permission_resolved  {user: alice, role: employee}
orchestrator  mcp_discovery        {ok: true, toolCount: 4}
orchestrator  clarification_requested  {}
orchestrator  turn_end             {delegated: false}
```

✔ The orchestrator **answers directly and does not offer** the capability (password reset is not
available to an employee) — it does not delegate a task it knows cannot be fulfilled. (A
non-delegating turn is recorded as `clarification_requested`.)

## 6 — Specialist lacks a capability (HR asked to reset a password) — Bob (IT admin)

_"…please have the HR specialist (not IT) reset the password for user alice."_ — **observed**:

```
orchestrator  permission_resolved  {user: bob, role: it_admin}
orchestrator  clarification_requested  {}
orchestrator  turn_end             {delegated: false}
```

> **Honest note.** Across several phrasings, the orchestrator **correctly refused to mis-route** a
> password reset to HR and answered directly — good behavior, but it means the "specialist receives
> the task and reports the limitation" path isn't exercised here. The underlying **agent-scope
> enforcement is nonetheless visible in every HR task's `permission_check`**: e.g. in scenarios 2, 7
> and 9, the HR specialist is denied `get_service_status` / `search_it_kb` with reason `agent_scope`.
> If a reset task _did_ reach HR, `reset_password` (registered `agents: [it]`) would likewise be
> denied `agent_scope`. The mechanism is also covered by `test/permissions.test.ts`.

## 7 — MCP integration failure — Alice, `MCP_MODE=timeout`

_"What's the annual leave policy?"_ with the MCP server in timeout mode — **observed**:

```
orchestrator  mcp_discovery        {ok: true, toolCount: 4}                      ← discovery still works
orchestrator  delegation_planned   {tasks: [{annual-leave-policy, agent: hr}]}
hr            tool_call            {name: search_policies, ok: false, error: "MCP error -32001: Request timed out", duration_ms: 5032}
hr            tool_call            {name: search_policies, ok: false, error: "MCP error -32001: Request timed out", duration_ms: 5011}
hr            tool_call            {name: search_policies, ok: false, error: "MCP error -32001: Request timed out", duration_ms: 5037}
hr            specialist_end       {status: partial, toolErrors: ["search_policies: MCP error -32001: Request timed out"]}
orchestrator  turn_end             {delegated: true}
```

✔ The per-call **5 s client timeout** fires (`duration_ms ≈ 5032`); the specialist degrades
gracefully, surfaces the `toolErrors`, and the orchestrator explains the limitation **without
fabricating a policy**.

## 8 — Upgrade existing equipment (3-hop chain) — Alice — _extra_

_"I want to upgrade my laptop — what can I get and is it within policy?"_ Expected: three waves
HR→IT→HR with `result_passed` at each hop (same mechanism as scenario 9 turn 2; not separately
captured here — plans vary run to run).

## 9 — Leave-request lifecycle (cross-user, stateful) — _extra_

Three turns across users; the shared `LeaveStore` Durable Object makes the request visible across
sessions. **Observed:**

**Turn 1 — Alice submits** _("Submit a leave request for me from 2026-12-20 to 2026-12-27, reason: holidays.")_:

```
orchestrator  delegation_planned   {tasks: [{submit_leave, agent: hr}]}
hr            tool_call            {name: load_skill, ok: true}
hr            tool_call            {name: search_policies, ok: true}       ← checks the leave policy
hr            tool_call            {name: read_policy, ok: true}
hr            tool_call            {name: submit_leave_request, ok: true}  ← request persisted (pending)
hr            specialist_end       {status: partial}
orchestrator  turn_end             {delegated: true}
```

**Turn 2 — Charlie (HR admin) lists + approves** _("List all pending leave requests, then approve the one submitted by alice."):_

```
orchestrator  delegation_planned   {tasks: [{list_pending, agent: hr}, {approve_alice, agent: hr, dependsOn: [list_pending]}],
                                    waves: [[list_pending], [approve_alice]]}            ← sequential chain
hr            permission_check     {allowed: [..., get_leave_requests, get_leave_balance, approve_leave_request],  ← approve ALLOWED (hr_admin)
                                    denied: [get_service_status/agent_scope, reset_password/user_role, search_it_kb/agent_scope]}
hr            tool_call            {name: get_leave_requests, ok: true}    ← admin sees all pending
hr            specialist_end       {list_pending, status: partial}
hr            permission_check     {approve_alice: approve_leave_request ALLOWED}
hr            tool_call            {name: approve_leave_request, ok: true} ← approved
hr            specialist_end       {approve_alice, status: ok}
```

**Turn 3 — Alice checks status** _("What is the status of my leave request?")_:

```
orchestrator  delegation_planned   {tasks: [{check_leave_status, agent: hr}]}
hr            tool_call            {name: get_leave_requests, ok: true}    ← employee sees only her own → now approved
orchestrator  turn_end             {delegated: true}
```

✔ Cross-user shared state · `approve_leave_request` **allowed for hr_admin** but denied
`user_role` for employees/it_admin (see scenarios 1–3) · sequential `dependsOn` chain.

---

## Capturing / re-capturing a live trace

1. Run the app (Docker or `yarn dev:all`). For scenario 7, start with `MCP_MODE=error` or
   `MCP_MODE=timeout`.
2. Send the prompt in the UI (flip the header **Trace** toggle to watch rows), **or** pull them:
   ```sh
   curl -s -H "X-User: alice" \
     "http://localhost:5173/api/sessions/<userId>:<sessionId>/trace" | jq
   ```
   The session instance name is `${userId}:${sessionId}`; the trace API is owner-checked.
