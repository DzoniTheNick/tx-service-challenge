---
name: leave-request-process
description: HR procedure for handling an employee leave request, grounded in company policy.
agents: [hr]
---

# Leave Request Procedure

Use this for any annual-leave or time-off question. Ground every statement in
company policy; never invent entitlements or approval rules.

1. **Read the policy.** Use `search_policies` / `read_policy` for the annual-leave
   policy and cite its version. Do not answer from memory.
2. **State the entitlement.** Report the accrual (paid days per year) and any
   carry-over limit from the policy.
3. **Explain the process.** How to submit (HR portal), the required notice period,
   and that manager approval is needed.
4. **Address the specific ask.** Answer the employee's actual question (e.g. days
   remaining, carry-over) using the policy; if the data needed is not available,
   say so plainly.
5. **Note limitations.** If something requires manager action or data you cannot
   access, state it rather than assuming an outcome.

Finish by calling `submit_result` with an honest status and any limitations.
