# PRODUCTION.md — Production deployment design (outline)

**Status: design/outline only. Nothing here is built during the MVP.** The MVP is local-only
(see `CONTEXT.md` §0a, D6). This document specifies the _opt-in_ path to run the assistant as a
real Cloudflare deployment, and the GitHub repo + CI/CD around it. Build it only when the user
explicitly asks; keep the 8 demonstration scenarios judged locally regardless.

This reverses several local-only decisions in `CONTEXT.md` §0a. Where they conflict, this
document governs **only** when a production deployment is being built.

---

## 1. What "production" means here

Two possible bars; this design targets the **secured** one:

- **Reachable demo** — deployed and public, no real auth. Rejected as a default: a public app
  with the `X-User` header switcher lets anyone impersonate `bob` (it_admin) and burn Workers AI
  neurons. Only acceptable with a hard usage cap and a loud README warning.
- **Secured deployment** (target) — real identity in front (Cloudflare Access), the `X-User`
  switcher demoted to an in-app _role selector_ behind that identity, usage bounded.

---

## 2. Deployment topology

```
Cloudflare Access (Zero Trust)  ── identity (Google/email), sits in front of the app Worker
   │  authenticated request + Cf-Access-Jwt-Assertion
   ▼
App Worker (Hono)  ── env.production
   ├─ Durable Objects (orchestrator, SQLite) — deployed with the Worker, DO migrations applied
   ├─ KV: SKILLS (real namespace id, seeded remotely)
   ├─ AI binding (Workers AI) — already remote
   └─ Service binding ──► MCP Worker (private; not publicly routable)
```

- **Two Workers**, as in dev: the app Worker and the MCP Worker, each with its own
  `wrangler.jsonc` / `env.production` block.
- **Durable Objects + SQLite** deploy with the app Worker; DO migrations run on deploy.

---

## 3. Authentication & identity

- **Cloudflare Access** (Zero Trust) in front of the app Worker's routes. Access handles login
  (Google / one-time-PIN / IdP) and injects a signed `Cf-Access-Jwt-Assertion`.
- The Worker **verifies the Access JWT** (against the team's public keys / `aud` tag) in the
  identity middleware, replacing the dev "trust the `X-User` header" rule.
- The real signed-in user maps to an app user/role; the in-app `alice`/`bob` switcher becomes a
  **demo role selector** usable only by permitted identities (or removed entirely in a locked-down
  deployment). Role is still bound to the session at creation and stored in SQLite.
- **Decision to confirm at build time:** full IdP-backed roles vs. a small allow-list mapping
  Access emails → roles.

---

## 4. MCP server exposure

- **Service binding (recommended):** the app Worker reaches the MCP Worker via an internal
  binding; the MCP Worker is **not** publicly routable. Requires adapting the MCP client
  transport from HTTP-URL (dev) to the service binding (prod). Keeps policy data off the public
  internet.
- **Public `*.workers.dev` URL (rejected for prod):** simplest, matches the dev HTTP client
  as-is, but anyone can hit the MCP server. Only for throwaway demos.
- `MCP_MODE` defaults to `ok` in `env.production`; the failure modes remain available for a
  deliberate scenario-7 demonstration.

---

## 5. Configuration, resources & secrets

- **`env.production` blocks** in both `wrangler.jsonc` files: real binding ids, routes/custom
  domain, vars (`MCP_MODE=ok`, model ids), and the service binding.
- **Real resources** (replacing the dev placeholders):
  - `wrangler kv namespace create SKILLS` → real id wired into `env.production`.
  - DOs created implicitly on first deploy.
- **Remote KV seeding:** `wrangler kv bulk put --binding SKILLS <file>` **without** `--local`
  (a `yarn seed:prod` script), run once after deploy / on skill changes.
- **Secrets:** `wrangler secret put` (not `.dev.vars`) for any model API key
  (`gpt-6-luna` / `gemini-3.8-flash`) if the production model is not the keyless Workers AI
  default. Keep `glm-4.7-flash` as the zero-secret production default where acceptable.

---

## 6. Model configuration in production

- Default stays **keyless Workers AI `glm-4.7-flash`** — no secret to manage.
- If a stronger model is wanted in prod, set `MODEL_ORCHESTRATOR=gpt-6-luna` (key via
  `wrangler secret put`), optionally **routed through Cloudflare AI Gateway** for caching, rate
  limiting, spend caps and request logging. Specialists can stay on glm to control cost.

---

## 7. GitHub repo & CI/CD

- **Repo:** a new GitHub repository (created when the user asks; `gh repo create`). `.gitignore`
  already covers `.wrangler/`, `.dev.vars`, `.yarn/*`.
- **CI (always):** GitHub Actions on PRs — `yarn install`, `yarn test`. Tests are fully offline
  (fake `LlmClient`, Miniflare), so CI needs **no** Cloudflare or model credentials.
- **CD (optional):** on merge to `main`, deploy both Workers with `cloudflare/wrangler-action`
  (app + mcp-server, and `yarn seed:prod`). Alternatively keep deploy **manual**
  (`wrangler deploy` documented) and let CI run tests only.
- **Least-privilege API token** for CD, stored as repo secrets `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID`. Scope: Workers Scripts (edit), Workers KV Storage (edit),
  Workers AI (read/run), Durable Objects — nothing broader.

---

## 8. Observability, cost & abuse controls

- **Spend/abuse caps:** Cloudflare AI Gateway spend limits and/or app-level per-session rate
  limiting; a hard neuron budget so a public demo can't be drained.
- **Logs:** structured trace already `console.log`s JSON → Workers Logs / Logpush. Optional D1
  mirror of the trace as an audit log (stretch S3 in `CONTEXT.md`).
- **Health:** `GET /api/mcp/status` already reports MCP connectivity/mode; add a basic
  liveness route.

---

## 9. Security posture (to state in the deployment README)

- Permissions are enforced in **code** (`allowedTools`), not by the LLM, so prompt injection
  cannot escalate capability — the production surface inherits this property.
- MCP is **fixed config**, not user-supplied (no runtime `addServer`), and private via service
  binding.
- No credentials, API keys or model reasoning in the trace.
- Identity is verified from the **Access JWT**, never from message text or a client header.

---

## 10. Out of scope / later

- Runtime `MCP_MODE` toggle (stretch S2), crash-resume checkpointing + D1 audit mirror (S3),
  live progress broadcast (S4), sensitivity-tiered policies (S5), cross-session memory (S7).
- Multi-region / custom-domain specifics, blue-green deploys, and IdP group → role mapping are
  deferred until a concrete production target is chosen.

---

## 11. Build order (when production is requested)

1. Add `env.production` blocks + service binding; adapt the MCP client transport.
2. Create real KV namespace; wire ids; add `yarn seed:prod`.
3. Put Cloudflare Access in front; implement Access-JWT verification in the identity middleware.
4. Scoped API token + repo secrets; GitHub Actions (CI tests, then optional CD).
5. First deploy of both Workers; remote seed; smoke-test the 8 scenarios against the deployment.
6. Add spend caps / rate limiting; write the deployment section of the README.
