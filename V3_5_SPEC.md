# V3_5_SPEC — Marketplace + Enterprise White-Label

> Tangerine v3.5. ~8 weeks. Ships after v3.0. Two surfaces in one cycle: a public marketplace for community-published vertical templates, and the first enterprise white-label tier for buyers who want their own brand on top of our stack. Trigger-gated. Distribution layer for both ends of the funnel.

## §0 North Star

**v3.5 turns Tangerine into a distribution layer.**

Below the line: a marketplace where community authors ship vertical templates (legal, sales, design, ops, product) to OSS users. Tangerine takes 10-15% on transactions. Above the line: a white-label tier for enterprise buyers wrapping our stack in their own brand, domain, SSO, audit trail.

One spec, two motions. Shared infra (Stripe Connect from v2.5, telemetry, theming). Split go-to-market — marketplace is community-led; white-label is direct sales.

Outward messaging:

> "Tangerine is the OS layer. v3.5 ships the surface above and below it. Authors ship verticals. Enterprises ship their brand. We sit in the middle and take a cut."

Non-goals: NOT a multi-vendor app store (only Tangerine templates and forks). NOT per-template subscription billing (one-time + free only). NOT a hosted on-premise installer (reserved post-v3.5).

`COMPETITIVE_ADVANTAGE.md` §0 exclusion test still holds: v3.5 doesn't lock users to cloud, gate data, or bloat per-seat pricing. Marketplace is opt-in; white-label is on-prem-capable; both ride on AGPL + dual commercial license.

## §1 Marketplace Architecture

The marketplace is a single Tauri-side surface (`/marketplace` route) plus a backend module (`app/src-tauri/src/marketplace.rs`) that talks to a registry service hosted on Tangerine Cloud. Templates are versioned, signed, and installable in one command.

### 1.1 What is a "template"

A marketplace template is a bundle of four files:

| File | Purpose | Format |
|---|---|---|
| `prompts.toml` | Co-thinker prompt pack tuned for the vertical | TOML, key-value, signed |
| `sources.config.json` | Source-connector configuration (Notion / Slack / Email tuned for the domain) | JSON, schema-validated |
| `canvas.template.json` | Canvas templates (case prep / contract review / sprint planning) | JSON, schema v1 |
| `suggestions.rules.toml` | Suggestion engine rule pack (vertical reasoning rules) | TOML, signed |

A template is one zip. Authors publish via `tangerine template publish ./my-pack`. The CLI signs it with the author's GPG key registered with their account, uploads to the registry, and a marketplace listing is created in `pending` state.

### 1.2 1-click install

End-users install with:

```
tangerine template install acme-legal-pack
```

This pulls the template from the registry, verifies the signature, and merges it into the user's local config under `~/.tangerine/templates/acme-legal-pack/`. Co-thinker, sources, canvas, and suggestion engine pick up the new files on next restart (or hot-reload via the existing v2.x file watcher). No additional config required.

GUI parity: `/marketplace` route shows listings; "Install" button does the same thing under the hood.

### 1.3 Take rate — 10-15%

Ratified in `BUSINESS_MODEL_SPEC.md` §10 line 5 (Pricing Lock). The 10-15% range is the launch band — exact rate set per template tier (free templates = 0%, $1-49 templates = 10%, $50+ templates = 15%). Below App Store's 30% to keep authors retained as the funnel; above Hugging Face's 0% to fund marketplace ops.

Authors get paid via Stripe Connect, which already exists from v2.5 inference-credit infrastructure. No new payment integration required — we reuse the same payout flow with a different receiver.

### 1.4 Per-template versioning + dependency graph

Each template publishes with semantic versioning (`acme-legal-pack@1.2.3`). The registry stores all versions; users can pin or update.

Dependency graph: a template can declare `requires` on other templates. Example: `acme-contract-review` requires `acme-legal-base`. The install resolver pulls the dependency tree before applying. Circular dependencies blocked at publish time.

Conflict resolution: if two installed templates declare conflicting prompt-pack keys, the more-recently-installed wins, with a UI banner warning the user. Backend log captures every conflict for support escalation.

### 1.5 Stripe Connect — reused, not rebuilt

Stripe Connect was wired up in v2.5 to handle inference-credit payouts when a customer's deployment serves multiple downstream teams. v3.5 reuses the exact same flow, just with `template_author` as the receiver type instead of `inference_route_owner`. Two extra DB columns, no new integration.

### 1.6 Backend module: `app/src-tauri/src/marketplace.rs`

Rust module on the Tauri side. Responsibilities: registry HTTP client (auth, list, fetch, search), local install / uninstall / update, signature verification against author GPG key, conflict detection, bridge to Tangerine Cloud for purchase + payout.

Tauri commands exposed to React: `list_templates`, `install_template`, `uninstall_template`, `search_templates`, `get_template_reviews`, `submit_review`.

### 1.7 Frontend: `/marketplace` route

React route under the existing app shell. Three subroutes: `/marketplace` (landing + featured + categories), `/marketplace/:id` (listing detail — description, screenshots, version history, reviews, install button), `/marketplace/publish` (author-only).

Listings show: title, author handle, version, install count, average rating, dependency tree, screenshots (3-5 PNGs), category, language, last-updated.

### 1.8 Search + filter

Three filter axes (matches `COMPETITIVE_ADVANTAGE.md` ICP fan-out):

| Axis | Values |
|---|---|
| Industry | legal / sales / design / product / ops / engineering / finance / healthcare / education |
| Vertical | role-specific (contract-review, fundraise-warroom, sprint-planning, etc.) |
| Language | en / zh / ja / es (templates can ship multi-language prompt variants) |

Search backend is Postgres full-text on title + description + tags. Sub-100ms p50 latency for queries up to 10k templates. Above that, swap to Meilisearch or Typesense — deferred until install volume justifies the migration.

### 1.9 Review + rating system

Five-star + free-text. One review per (user, template, version) pair to prevent pumping. Public, attributed to author handle.

Moderation: automated flag via OpenAI moderation API; manual queue for flagged. Author responds once per review (no infinite threads).

Anti-abuse: rate-limit (max 5 reviews / user / day) + sock-puppet detection on signup IP / device-fingerprint. First 90 days = manual triage of flagged accounts. Automate after.

## §2 Marketplace Launch Trigger Gate

The marketplace ships **only when both conditions are met**, ratified in `BUSINESS_MODEL_SPEC.md` §10 line 5:

1. **5,000 OSS installs**, measured by telemetry route `navigate_route` daily-uniques over a rolling 30-day window. Source: existing telemetry stream from v1.9.
2. **1 self-shipped vertical template** that has been internally validated (used by ≥3 design-partner teams for ≥30 days with ≥4-star qualitative feedback).

Both are non-negotiable. Premature marketplaces die from empty shelves — Hugging Face Spaces, Vercel templates, Discord bot stores all teach the same lesson.

**Public commitment**: the trigger metrics are published in the README and on the website. We post them publicly so the community sees we're not hiding the bar. Transparency on metric thresholds is the same play as transparency on inference margin (`BUSINESS_MODEL_SPEC.md` §10 line 3).

What happens if we miss the gate at 12 months: per `WHY_OSS_MONETIZES_SPEC.md` §5 Plan B, if installs <1000 we relicense to BSL and refocus. If installs >1000 but <5000, we slide marketplace to v3.6 and ship enterprise white-label first.

## §3 First Vertical Template — Self-Ship (Launch Ammo)

Marketplace launches with one template **on the shelf**, written by the Tangerine team. This is the validation pack — proves to the community that the format works, that the take-rate math is real, and that 1-click install actually works.

### 3.1 Choice: "Tangerine for Legal Teams"

Selected over sales / design / product / ops because: contract review + case research are bounded, repetitive, AI-friendly tasks; legal data residency aligns with our local-first moat (`COMPETITIVE_ADVANTAGE.md` §1 Moat 3); solo / small-firm lawyers are reachable via Twitter + targeted outreach (F500 legal procurement is a 12-month cycle we don't want yet); $199 one-time is below friction threshold for solo lawyers ($30-50/hr billing rates, $199 ≈ 5 hours saved).

Sales / design / product reserved for v3.6+ vertical packs. Ops reserved for the iFactory pillar (TII), kept separate from OSS marketplace.

### 3.2 Bundle contents

| Component | Specifics |
|---|---|
| Co-thinker prompts | Legal context: contract clause taxonomy, case-law citation patterns, Westlaw / LexisNexis-style query templates, plain-language explainer mode |
| Sources config | Notion (case files), Slack (intake channel), Email digest (court filings, opposing counsel correspondence), tuned glob patterns for `.docx` / `.pdf` legal docs |
| Canvas templates | Case prep, contract review, motion draft, deposition prep — 4 starter canvases |
| Suggestion templates | Decision-drift detector for legal opinions, deadline reminders for filing dates, conflict-of-interest auto-flag |

### 3.3 Pricing — split offer

First 100 installs: free, in exchange for written feedback (launch testimonials). Install 101+: $199 one-time. Renewals: free, perpetual updates with original purchase.

Free-then-paid is the Plausible / Cal.com pattern — seed adoption, charge thereafter, no hidden subscription.

### 3.4 Author identity

Published under the official `tangerine` author handle, signed with the company GPG key. Different visual treatment in the listing — "platform-curated." v3.6+ adds a `tangerine-verified` badge for community templates that pass our internal quality bar.

## §4 Enterprise White-Label

The above-the-line surface. F500 / industry-leader buyers who want a Tangerine-equivalent product with their own brand on every pixel and their own domain on every URL.

### 4.1 Branding customization

| Element | Customization |
|---|---|
| Logo | SVG / PNG, displayed in app shell header, login page, exported docs |
| Color palette | Primary, secondary, accent — three CSS variables propagated through the entire React tree via theme provider |
| Domain | `${customer-name}.tangerine-cloud.com` (default) OR full custom domain (`tangerine.acme.com` via CNAME, customer manages DNS) |
| Product name | Configurable display name — "Acme-AGI", "LawCorp Co-Thinker", "Tangerine" — replaces all visible "Tangerine" strings |
| Email sender | `noreply@${domain}` for transactional email — buyer's domain, our SMTP infrastructure (SPF / DKIM signed via DNS records customer publishes) |

What we do NOT white-label: the AGPL footer, the "powered by Tangerine" attribution in the help dialog, the open-source repository link. These are required by our license + brand strategy. Buyers who want to remove these get the on-premise package (§4.3) which doesn't display them.

### 4.2 Per-tenant deployment isolation (Cloud)

Each white-label customer is a separate Tangerine Cloud tenant, isolated at four layers: Postgres (separate database per tenant via PgBouncer, not row-level tenant_id); inference (separate DeepSeek API key + quota tracking); brain doc storage (per-tenant S3 / R2 bucket); logs (per-tenant Loki stream).

Heavier than multi-tenant SaaS, required for the compliance story. Audit logs, data residency, breach blast radius all benefit.

### 4.3 On-premise package (self-host)

For buyers who reject cloud entirely (most regulated industries, all China F500). Docker Compose bundle: `app` (Tauri runtime), `postgres` (data + audit), `redis` (queue + cache), `inference-router` (local Ollama, on-prem DeepSeek, customer API key, etc.).

Tarball + 4-page deployment runbook. Customer runs on their own k8s / VM. No phone-home, no telemetry, audit log local-only. License: dual-commercial, scoped to the legal entity, prohibits redistribution.

### 4.4 Custom theme injection in app shell

App shell loads `theme.json` from tenant config endpoint at boot. CSS-variable-driven, no rebuild. Theme changes apply within 5 seconds of admin edit.

Complex customizations (custom layout, custom widgets) = "professional services" at $20k flat — our engineer ships the custom React components.

### 4.5 Pricing band

| Tier | Price | What's included |
|---|---|---|
| Starter (white-label) | $25,000 one-time + $5,000/year maintenance | Up to 50 users, branding, custom subdomain, SSO, audit log, 24/7 priority email support |
| Professional | $50,000 one-time + $10,000/year | Up to 200 users, custom domain, region routing (EU + US + China), 99.9% SLA, dedicated success engineer (10 hrs/quarter) |
| Enterprise | $100,000 one-time + $25,000/year | Unlimited users, on-premise option, custom theme, custom data residency, 99.95% SLA, dedicated success engineer (40 hrs/quarter) |

The 1-time license + annual maintenance contract is the Mattermost / GitLab / Sentry pattern. NOT a recurring SaaS subscription. NOT per-seat. The maintenance contract is what funds support + bugfix backports.

Floor of $25k is set deliberately to filter out tire-kickers — the deal cycle is too expensive otherwise.

## §5 Enterprise Compliance + Admin

Enterprise is gated on compliance and admin features that white-label buyers won't sign without.

### 5.1 SSO SAML

Two providers prioritized for v3.5: **Okta and Azure AD** (~80% of F500). Google Workspace SSO deferred to v3.6.

Standard SAML 2.0, IdP- and SP-initiated. Implemented via `keycloak-rs` or equivalent — battle-tested, handles encrypted assertions, signed responses, SP metadata exchange.

JIT provisioning: first SAML login creates the Tangerine user. Group / role mapping configurable per tenant.

### 5.2 Audit log

Every state-mutating action is logged. Sources: user auth events (login / logout / password / SSO link); brain doc edits (write / delete / rename); source config changes; template installs / uninstalls; admin actions (create / disable / role grant); inference invocations (model + token count + prompt hash, NOT prompt text by default — opt-in for compliance debug).

Format: structured JSON, one event per line, append-only, HMAC-chained (each event includes hash of previous — tamper-evident).

Storage: per-tenant S3 bucket with object lock + 7-year default retention (customer-configurable).

Audit log is **separate from telemetry**. Telemetry = opt-in, anonymized, product analytics. Audit log = mandatory for enterprise tenants, identified, compliance-only.

### 5.3 Region routing

Enterprise tenants pick one of three regions at provisioning:

| Region | Hosted in | Inference provider | Compliance bar |
|---|---|---|---|
| China | Alibaba Cloud Beijing | DeepSeek (Hangzhou) | PIPL + 等保三级 |
| US | AWS us-east-1 / us-west-2 | DeepSeek US (TBD) or Anthropic | SOC 2 Type II + HIPAA on request |
| EU | AWS eu-west-1 (Frankfurt) | Mistral or Anthropic EU | GDPR + EU AI Act compliance |

All data — Postgres, brain doc, audit log, inference traffic — stays within the chosen region. No cross-region replication unless customer explicitly enables it.

This unlocks regulated industries (legal, healthcare, finance, defense, China F500) on day 1. China region day-1 was ratified in `BUSINESS_MODEL_SPEC.md` §10 line 4 (Compliance Lock).

### 5.4 Admin console

Web UI at `/admin/` for tenant admins. Capabilities: user management (invite / disable / role / remove); license enforcement (current usage vs cap, hard cap on overage by default, soft cap configurable); per-team usage analytics (token spend, source connector usage, top suggestion consumers); audit log search + export (CSV / JSON / time-range); region status; SLA dashboard (uptime % over last 30 / 90 days); branding settings (logo upload, color picker, theme preview).

React, lazy-loaded so non-admins don't pay bundle-size cost.

### 5.5 Per-tenant SLA

| Tier | Uptime SLA | Response time SLA | Penalty |
|---|---|---|---|
| Starter | 99.5% | P1 within 8 hrs business day | 10% credit on next year's maintenance |
| Professional | 99.9% | P1 within 4 hrs 24/7 | 20% credit |
| Enterprise | 99.95% | P1 within 1 hr 24/7 | 30% credit + executive escalation |

Penalty enforcement is contractual, billed via maintenance-contract credit, not refund-to-bank. The cap is annual maintenance fee — we don't refund the original license.

## §6 Implementation Phasing — 8 Weeks

Five phases. Each phase has a hard acceptance gate (§7). No phase ships without gate pass.

### alpha.1 — Marketplace backend + first vertical template (2 weeks)

Week 1-2.

- Build `app/src-tauri/src/marketplace.rs` — registry client, install logic, signature verification
- Build commission engine — Stripe Connect integration, payout flow
- Build registry service backend (Postgres + minimal HTTP API)
- Self-ship "Tangerine for Legal Teams" template (§3) — internal-only, not yet listed publicly

### alpha.2 — Marketplace UI + 1-click install + ratings (2 weeks)

Week 3-4.

- Frontend `/marketplace` route + listing pages
- 1-click install button + backend-frontend Tauri bridge
- Search + filter UI
- Review + rating UI + moderation backend

### beta.1 — Enterprise white-label + branding (2 weeks)

Week 5-6.

- Per-tenant deployment isolation (Postgres-per-tenant, S3-per-tenant)
- Branding customization (logo upload, color theme, custom subdomain)
- On-premise Docker Compose bundle
- Tenant provisioning admin tool

### beta.2 — SSO SAML + audit log (1 week)

Week 7.

- SSO SAML integration (Okta + Azure AD)
- Audit log infrastructure (HMAC-chained, per-tenant S3, append-only)

### final — Region routing + polish + ship public (1 week)

Week 8.

- Region routing (China + US + EU)
- Admin console final
- Public marketplace launch (only if §2 gate passes)
- Public white-label tier launch (regardless of marketplace gate)

## §7 Per-Phase Acceptance Gates

| Phase | Gate |
|---|---|
| alpha.1 | First vertical template installs end-to-end on a clean Tauri build. Stripe Connect payout flow tested with real $1 transaction (refunded). Registry HTTP API passes integration tests. |
| alpha.2 | A non-engineer (designer or PM) can search, install, and rate a template without docs. Time-to-first-install <60 seconds. Mobile-responsive (we test at 768px even though desktop is primary). |
| beta.1 | Two test tenants provisioned with different branding. Each tenant only sees own data (Postgres-level isolation verified by penetration test). On-premise Docker Compose runs on a fresh VM. |
| beta.2 | Okta + Azure AD SAML logins both succeed. Audit log captures 5 mutation events end-to-end with HMAC chain validated. Admin can search + export logs. |
| final | Region routing tested: a EU tenant's data stays in eu-west-1 (verified via traceroute + DNS resolution + S3 bucket-region check). Public marketplace launch: §2 gate passed. White-label tier: launch press / announcement coordinated. |

## §8 Dependencies

v3.5 depends on:

| Dependency | Source | Status |
|---|---|---|
| v3.0 ship | Prior spec | Required before v3.5 alpha.1 |
| Stripe Connect integration | v2.5 | Live, reused |
| Postgres + S3 infrastructure | v2.0 (paywall infra) | Live |
| Telemetry stream | v1.9 | Live, used for trigger gate |
| Legal: marketplace commercial terms locked | Open as of 2026-04-26 | Must close before alpha.1 — author agreement, take-rate disclosure, dispute resolution clause |
| Legal: white-label commercial license template | Open | Must close before beta.1 — non-redistribution, audit-rights, termination clauses |
| First enterprise customer pipeline | Open | Need 3+ qualified leads before final phase to validate price band |

Legal is the hard blocker. Engineering can build all of v3.5; without the agreements, we can't take a single transaction.

## §9 Out of Scope

NOT in v3.5:

- **Per-template subscription billing** — launch is one-time + free only. Deferred to v3.6+ pending author demand
- **Multi-tenant vendor app store** — only Tangerine-published or Tangerine-fork templates; no third-party vendor binaries or runtimes
- **On-premise deploy script for marketplace** — marketplace registry is cloud-only; white-label customers self-host the app but registry stays cloud
- **iFactory / TII vertical templates** — TII separate pillar; OSS marketplace covers software-team verticals only
- **Marketplace API for external integrations** — no public API at v3.5
- **Author analytics dashboard** — authors get raw install counts and revenue; richer analytics deferred to v3.6
- **Marketplace search across forks** — only canonical templates indexed

## §10 Risks (5)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Template quality dilution — community publishes low-quality templates that erode marketplace trust | high | medium | Three layers of moderation: automated lint at publish time, community review + rating system, manual curation badge for top-quality templates. First 6 months: every published template gets manual review before going live |
| 2 | Commission fraud — author publishes free template + collects manual payment off-platform to dodge our take rate | medium | medium | Stripe Connect required for paid templates; off-platform payments violate author agreement. Audit detected via install count vs reported revenue cross-check. Repeated violations = account ban + cleanup |
| 3 | SSO integration complexity — Okta + Azure AD edge cases (encrypted assertions, custom claims, MFA flows) burn engineering time | high | medium | Use battle-tested library (`keycloak-rs` or commercial SSO-as-a-service like WorkOS at $50/tenant/month). Don't build SSO from scratch. Budget for 2x estimated time for SSO debugging |
| 4 | Enterprise sales motion = 0 — we have no enterprise sales rep, no F500 references, no procurement playbook | very high | high | Hire fractional enterprise sales advisor (Stripe / Mattermost / Sentry vet) for $5k/month before final phase. Source 3-5 design partners pre-launch via warm intros from existing investors. First contract = reference customer, accept reduced margin |
| 5 | Legal terms enforcement — author publishes template that infringes IP / contains malicious code / violates take-rate agreement | medium | high | DMCA + takedown protocol clearly published. Code-scanning at publish (no eval, no exec, no fs writes outside template scope). Take-rate audit log + clawback clause. Account suspension for repeated violations |

## §11 Open Questions for CEO

Five calls before alpha.1 starts:

1. **First vertical**: legal vs sales vs design vs product vs ops. Recommendation: legal. Asks Daizhe — confirm or substitute. (Legal selected per §3.1; CEO override possible)

2. **Take rate band**: 10% / 15% / 25% (App Store). Recommendation: 10% for free + paid <$50, 15% for paid >$50. App Store-style 30% rejected — too aggressive, kills author retention. Asks CEO ratification of two-tier vs flat.

3. **White-label price floor**: $25k vs $50k vs $100k. Recommendation: $25k starter as filter, $50k professional as anchor, $100k enterprise as ceiling. Asks CEO whether starter floor of $25k is too low (adverse selection — buyers who can only afford $25k may not be the right ICP) or right (enterprise pipeline gating dictates broader top-of-funnel).

4. **Marketplace launch announce channel**: HN Show HN / Twitter / Product Hunt / 全部. Recommendation: all three on the same day, sequenced HN morning → Twitter midday → PH afternoon (PT). Build-in-public CEO posts the entire week leading up. Asks CEO whether to coordinate with a podcast (Lex / Acquired / Latent Space) to publish concurrently.

5. **SSO providers priority**: Okta first or Azure AD first. Recommendation: build both in parallel since the auth library covers both. If forced to pick, Okta first — broader SaaS adoption, more polished docs. Azure AD second for MS-365 enterprise customers. Asks CEO whether Google Workspace SSO is accepted as v3.6 deferred (vs adding to v3.5).

---

*V3_5_SPEC v1.0. Marketplace + enterprise white-label. 8 weeks. Trigger-gated. After v3.0.*
