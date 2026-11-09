---
name: troubleshooting
description: Structured first-level IT troubleshooting — diagnose, check status, give steps, escalate.
agents: [it]
---

# IT Troubleshooting Procedure

Follow these steps for any first-level IT issue. Be concrete and honest; never
claim a fix you did not verify.

1. **Clarify the symptom.** Restate what is failing and when it started.
2. **Check service status.** Use `get_service_status` for the affected service
   (vpn, email, wifi, printer) before guessing. If a service is `down` or
   `degraded`, say so and set expectations.
3. **Consult the knowledge base.** Use `search_it_kb` for the symptom and apply
   the documented steps.
4. **Give the user clear, ordered steps.** Keep it to the minimum that resolves
   the issue; note anything that needs admin rights.
5. **Escalate when blocked.** If the issue needs a capability you lack (e.g. a
   password reset for a non-admin) or a service is down, say what you cannot do
   and who/what the user should contact next.

Finish by calling `submit_result` with an honest status and any limitations.
