# BUSINESS_MODEL_SPEC — v1.0 lock

> Tangerine's monetization stack. v1.8 shipped the product (10 AI tools sidebar + 10 sources + Co-thinker brain + ambient layer). This spec locks how we charge for it. Anti-SaaS by construction. Three layers, with two more reserved for post-PMF.

## 0. North Star

**Pricing must move when our value moves.** Tangerine's value is the AI work it does on a team's behalf — capturing meetings, deduplicating decisions, briefing the next session, surfacing drift. The natural billing unit is **inference (tokens) + ecosystem (marketplace transactions)**, not human seats.

Outward messaging — locked, lifted into the README:

> "Tangerine is open source forever. Run it on your laptop. Or use Tangerine Cloud — $80/team/month flat, shared inference budget, no per-seat trap."

Non-goals: NOT a per-seat workspace SaaS. NOT a hosted-only product. NOT a license-locked closed-core. NOT charging for source connectors, AGI brain features, or the desktop app — all of those are OSS forever.

## 1. Why per-seat fails for AI-native

Per-seat is the dominant SaaS pricing primitive. It works for workspaces (Notion, Linear, Slack) where the seat = a human with a daily UI session. It breaks for AI-native infra in four ways:

| Per-seat assumption | AI-native reality | Implication for Tangerine |
|---|---|---|
| Headcount ≈ value | We replace coordination work — team gets smaller as value grows | Per-seat punishes our most valuable behavior |
| Every user uses the UI daily | 99% of Tangerine value happens ambient — brain doc, MCP inject, AGI peer surfacing through other tools | Seat count decouples from usage |
| Margin from pricing power | Our margin floor is `(sale price - inference cost)` — multi-model substitution defends it | SaaS pricing power doesn't apply |
| License locks customers | OSS Apache-2.0 explicitly destroys vendor lock | Defense moves to hosted layer + data insights |

**The reverse-incentive trap concretely**: imagine a 10-person team paying $20/seat/month = $2.4k/year. Tangerine's co-thinker is good enough that the team operates with 6 people in 6 months. Now we earn $1.4k/year — Tangerine got better, our revenue dropped 40%. Continue the trajectory and the most valuable customer (where we replaced the most work) becomes the lowest revenue. This is a structural anti-pattern.

**The fix**: charge per inference call (tokens consumed, regardless of headcount) or per ecosystem transaction (marketplace install). Both align our incentives with delivering more AI work, not gating fewer seats.

## 2. The 3-layer Stack

### 2.1 Layer 1 — OSS forever (free)

Apache-2.0. Full source code. No feature gating.

What ships in OSS:
- Desktop app (Tauri + React + Rust)
- 10 sources (Discord / Slack / GitHub / Linear / Notion / Calendar / Loom / Zoom / Email / Voice notes)
- Co-thinker AGI brain (heartbeat, brain doc, session borrower)
- Suggestion engine (chip / banner / toast / modal + 10 rule templates + LLM hook)
- MCP server (`npx tangerine-mcp`)
- Browser extension (Chrome / Edge)

Users self-host on laptop / VM / k8s. They can rename ("Acme-AGI", "Stripe-Co-Thinker"), fork, modify, redistribute. Inference goes through the **session-borrower** module which transparently uses the user's existing Cursor Pro / Claude Pro / Ollama — Tangerine sees zero marginal cost.

Reference precedents: Mattermost, Cal.com, Plausible, Supabase, PostHog. OSS is not the revenue channel; it's the funnel and the credibility layer.

### 2.2 Layer 2 — Tangerine Cloud — $80/team/month flat + overage credits

Optional zero-config path. A team that doesn't want to wire up its own Cursor Pro subscription pays a flat base for the whole team and gets a shared DeepSeek inference budget.

**Wholesale**: DeepSeek V4 (Chinese open-weights frontier model, 2026 wholesale ~10× cheaper than Claude Sonnet). Tangerine runs a single shared API key per team — billing complexity stays our problem, not the customer's.

**Pricing primitive**: $80/team/month flat base. Includes ~100M tokens/month shared across the whole team (covers ~30 active users at typical co-thinker burn). Above that, overage credit packs at **$5 per 10M tokens**. No per-seat charge. No tier ladder.

| Component | Price | Coverage |
|---|---|---|
| Base | $80 / team / month | ~100M tokens included |
| Overage | $5 / 10M tokens | raw DeepSeek wholesale ~$2.70 / 10M → 1.85× markup |

**Margin math at base**: 100M tokens at DeepSeek wholesale (80/20 input/output split) ≈ $30 raw cost. At $80 retail, **gross margin ≈ $50/team/month (62%)**. Most teams burn far less than 100M (5-20M typical), so realized margin is materially higher — see §3.2.

**Why $80 flat instead of per-token**: (1) users hate "surprise bill at end of month" — a flat base sets the expectation, overage is rare; (2) DeepSeek wholesale account billing complexity (FX, Chinese invoice, reseller routing) stays our problem; (3) confident pricing — GitHub Copilot $19/seat, Cursor Pro $20/seat, Linear $8/seat all charge confident prices. $80/team flat for a 5-person team = $16/seat-equivalent vs ChatGPT Team $25/seat — still ~36% cheaper, but 16× revenue per Cloud team for us.

**Comparison vs alternatives** (raw inference $/M tokens):

| Provider | Input $/M | Output $/M | Notes |
|---|---|---|---|
| Claude Sonnet 4 | $3.00 | $15.00 | 100M tokens ≈ $330 raw — base would have to be ~$500/team to hit 30% margin |
| OpenAI GPT-4o | $2.50 | $10.00 | Similar economics |
| **DeepSeek V4 (our choice)** | **$0.27** | **$1.10** | 100M ≈ $30 raw — supports $80 base at 62% margin |
| Llama 70B (self-host) | $0 | $0 | User hosts; no Tangerine revenue |

DeepSeek V4 is the only wholesale point that supports a confident flat base. If DeepSeek wholesale changes, the inference-router abstraction (already in v1.8 session-borrower) swaps to a different provider with one config change; pricing review trigger codified in §10.

### 2.3 Layer 3 — Marketplace (v2.0)

User-uploaded vertical templates, prompt packs, source mappings, suggestion rule packs. Tangerine takes 18% on each transaction (sellers keep 82%).

Examples of what users upload:
- "YC startup CEO co-thinker" (prompt pack)
- "PCB factory ops template" (source mapping + suggestion templates for Tier-2 PCB)
- "Patent law firm decision-drift detector" (vertical reasoning rules)
- "Series B fundraise war-room template" (atom schema + brief format)

**Pricing primitive**: take rate on transactions. Authors set prices (free, one-time, subscription). No commitment from Tangerine on volume.

Reference precedents: Vercel (15-20% on functions/integrations), npm + GitHub Sponsors (free side), Hugging Face Spaces, App Store. 18% is the Vercel midpoint — lower than App Store's 30% (we want author retention as the funnel) and higher than Hugging Face's 0% (we need margin for marketplace ops).

Launches with Stage 3 (M6-M9, 2027 Q1-Q2). v1.9 (current) does not include marketplace — the suggestion engine spec is the priority.

## 3. Inference economics in detail

### 3.1 Token-burn model per team

A team's monthly token consumption is the sum of:

| Workload | Token type | Tokens/month |
|---|---|---|
| Co-thinker heartbeat (every 5 min) | input + small output | ~3M |
| 30-min brain-doc refresh | input + medium output | ~1M |
| Suggestion engine LLM hook (rate-limited) | input + small output | ~0.5M |
| User-initiated Cmd+K queries (5-10/day, ~1k tokens each) | input + small output | ~0.5M |
| **Total** | | **~5M tokens/month** |

Variance: heavy teams (large brain doc, fast standup cadence) hit 20-50M/month. Light teams hit 1-2M/month. The pricing model handles both — pay-per-token is linear in usage.

### 3.2 Margin structure

The base is $80/team/month for ~100M included tokens. Realized margin depends on how much of the 100M the team actually burns.

| Scenario | Actual usage | Raw DeepSeek cost | Retail | Margin |
|---|---|---|---|---|
| Light team | 5M tokens | ~$1.50 | $80 base | ~$78.50 (98%) |
| Normal team | 20M tokens | ~$6 | $80 base | ~$74 (92%) |
| Heavy team | 50M tokens | ~$15 | $80 base | ~$65 (81%) |
| At-cap team | 100M tokens | ~$30 | $80 base | ~$50 (62%) |
| Over-cap team | 150M tokens (50M overage) | ~$45 raw | $80 + $25 overage = $105 | ~$60 (57%) |

Most teams won't hit overage. The 100M ceiling is sized for ~30 active users and the typical team is 5-15. Realized blended margin across the install base is expected to sit ~85-90% on the base subscription.

Pricing power upside: if DeepSeek wholesale drops 30% in 12 months (consistent with the trend), margin expands without changing user price. We don't need to raise prices to grow margin.

Pricing power downside: if DeepSeek wholesale doubles, base still profitable at any usage below ~70M tokens, and overage retail moves with the inference-router swap. §10 codifies the 30% pre-commit margin floor and quarterly review.

### 3.3 Compared to per-seat

| Team size | ChatGPT Team ($25/seat) | Tangerine Cloud ($80 flat) | User saves |
|---|---|---|---|
| 5 people | $125 / month | $80 / month | 36% |
| 10 people | $250 / month | $80 / month | 68% |
| 30 people | $750 / month | $80 / month | 89% |
| Self-host (any size) | n/a | $0 | 100% |

The comparison gets more lopsided as the team grows — per-seat scales with headcount, our base stays flat until the 100M-token cap. The "missing" revenue is the lock-in tax we're refusing to charge.

## 4. Optional Layer 4-5 (post-PMF)

### 4.1 Layer 4 — Enterprise white-label

$50k-200k/year license + annual support contract. Buyer gets:
- Self-hosted private deployment
- SSO / SAML / SCIM
- Audit log + SOC2 path (HIPAA on request)
- Custom branding ("LawCorp Co-Thinker")
- Dedicated success engineer

Trigger to ship: 1-2 strong inbound demand signals from law firms / fintech / healthcare with stated budget. Currently zero. Stage 4-5 evaluation.

### 4.2 Layer 5 — Tangerine Behavioral Index

100% opt-in: users contribute anonymized atom streams. Tangerine trains a universal team-work model. Sells model access to enterprise (benchmarking) and research (academic).

Triggers to ship: ≥ 1k teams running with telemetry opt-in + clear use case from prospect. Currently 0 teams in this state. Post-PMF only.

Both Layer 4 and Layer 5 are explicitly **deferred**, not roadmapped. The risk is over-committing to enterprise/data revenue before the Cloud subscription motion has product-market fit.

## 5. Launch sequence

| Phase | Timing | Layer | Status |
|---|---|---|---|
| Foundation | now → 2026 Q3 | Layer 1 (OSS) | v1.8.1 shipped, CI building installer |
| v1.9 SUGGESTION_ENGINE | 2-4 weeks (May 2026) | Layer 1 (still OSS) | Spec written; phased beta.1 → final |
| Tangerine Cloud MVP ($80 flat + overage) | 2026 Q3 (Stage 1 → 2 transition) | Layer 2 | Build router + shared DeepSeek wholesale key + Stripe subscription + overage credit packs |
| Marketplace MVP | 2027 Q1-Q2 (Stage 3) | Layer 3 | Empty listings + upload flow + payout |
| Layer 4 spike | 2027 Q3-Q4 (Stage 4-5, conditional on inbound) | Layer 4 | Compliance work + SSO + private deploy hardening |
| Layer 5 evaluation | 2028+ (post-PMF) | Layer 5 | Conditional on telemetry adoption + research demand |

## 6. Unit economics modeling

Cloud base $80/team/month flat. ~30% of active teams convert to Cloud (the rest stay self-host on Layer 1). Self-host teams contribute $0 directly but expand brand reach + funnel.

| Total active teams | Cloud teams (~30% conversion) | Cloud ARR | Marketplace | Enterprise | **Total ARR** |
|---|---|---|---|---|---|
| 100 | 30 | $28.8k | $0 | $0 | **$29k** |
| 1,000 | 300 | $288k | $20-40k | $0 | **$308-328k** |
| 10,000 | 3,000 | $2.88M | $300k | $50-100k (1-2 ent) | **$3.2-3.3M** |
| 100,000 | 30,000 | $28.8M | $3-5M | $1-2M (10-20 ent) | **$33-36M** |

The 2026-04-26 projection at 100k teams was $1.1-1.5M ARR; the 2026-04-27 repricing yields $33-36M — 16× revenue per Cloud team plus higher marketplace + enterprise tiers compounds to ~25× total ARR uplift.

Sensitivity:

- If conversion is 50% (more zero-config users): Cloud ARR scales 1.67×
- If 20% of Cloud teams hit overage at average $25/month extra: Cloud ARR scales ~1.06×
- If DeepSeek wholesale halves: margin expands, retail price stays — base margin moves from 62% → ~80% at the 100M cap
- If DeepSeek wholesale doubles: §10 30%-margin-floor pre-commit triggers a pricing review

The unit economics work at scale and now also at small N — the flat base means even 100 active teams (30 Cloud) clear $29k ARR vs $720 under the old per-token model.

## 7. Risks + Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | Hyperscaler clones the OSS (AWS / Cloudflare hosted Tangerine) | medium | high | Apache-2.0 permits this. We defend with: (a) most polished hosted layer (1-click setup, no devops); (b) DeepSeek wholesale account they can't easily replicate; (c) brain-doc data insights they don't have access to (pure local); (d) fastest iteration speed (we ship the spec, they react to it). Don't try to defend with license. |
| 2 | DeepSeek V4 wholesale price changes (hike or geopolitics) | high | medium | Inference router (already in session-borrower) abstracts the provider. Failover providers: Claude Haiku (3-5× more expensive but stable), Llama 70B self-host (free but quality regression), GPT-4o-mini (similar to DeepSeek pricing). Worst case: raise retail price by ~2× and retain margin. |
| 3 | Inference quality regression vs Claude/GPT | medium | medium | Quality-gate on suggestion engine: every template has a confidence floor. If DeepSeek under-performs, suggestion engine drops below threshold and silently fails — UX still functional, just less proactive. User can switch to their own Cursor Pro (Layer 1 path) if dissatisfied. |
| 4 | OSS contributors fragment / compete | medium | medium | CLA on every PR (already required). Apache-2.0 + CLA = contributors agree their code can be redistributed under any license, including commercial. Prevents fork-and-monetize. Active commit cadence + clear governance on who lands what. |
| 5 | Users self-host with their own Cursor Pro and skip Tangerine Cloud entirely | high | medium | This is by design — it's the OSS funnel path. The funnel is Self-host ($0) → Cloud ($80 flat). Cloud customers are the zero-config segment, not the entire user base. Plan for Cloud to capture ~30% of active teams long-term, not 100%. |
| 6 | Marketplace fails to attract authors | medium | medium | Bootstrap with first 5-10 templates internally (vertical anchors: PCB factory, YC startup, patent law firm). Run referral program for early authors. 18% take rate is still well below App Store's 30% — author retention should hold. If still fails after 6 months: deprioritize marketplace, double down on Layer 2. |
| 7 | Inference cost spike from runaway co-thinker loops | low | high | Per-team rate limits (max 50M tokens/month before alerting user). Per-template budget guards (suggestion engine LLM-hook capped at 1 call per 30 min). Server-side circuit breaker on per-team monthly cap with auto-throttle. |

## 8. License

**Apache-2.0**, no upgrade to BSL or SSPL.

Rationale:

1. **Real OSS makes the funnel work.** Apache-2.0 lets AWS / Cloudflare host Tangerine. We accept that. The defense is hosted layer quality + DeepSeek cost + speed of iteration, not license restrictions.
2. **Anti-SaaS positioning aligns with Apache-2.0.** We sell inference + marketplace transactions. We're not selling code. SSPL's "block AWS clone" logic conflicts with our funnel-first GTM.
3. **CLA covers the IP question.** Every contributor signs the CLA at PR time, granting Tangerine permission to redistribute their contribution under any license including commercial. Prevents the contributor-fork-then-host-it scenario.
4. **Distribution > license control for AI-native ICP.** Developers in our segment specifically value Apache-2.0 / MIT — anything more restrictive carries adoption tax ~5-10× over Apache-2.0.

Reference: Mattermost (MIT), Cal.com (AGPLv3 — borderline), Plausible (AGPLv3 — borderline), Supabase (Apache-2.0), PostHog (MIT). The pattern that works at our scale + ICP is Apache-2.0 or MIT.

Counter-references (what we're explicitly not doing): HashiCorp BSL (alienated community in 2023), MongoDB SSPL (alienated AWS ecosystem), Elastic SSPL → Apache reversal (admitted SSPL didn't work). The license-as-defense model has structural problems we don't want to inherit.

## 9. Open Questions for CEO — ratified status

1. **DeepSeek wholesale account setup** — `status: open, urgent` (CEO 仍要看 accounting + legal,US Inc. → DeepSeek 直接 vs 走 HK / Singapore reseller。$80 flat base + shared team key 模式让这件事比之前更紧迫 — Cloud 一上线就需要 wholesale 账号支撑共享 inference。Layer 2 GA 之前必须答)
2. **Marketplace take rate** — `status: ratified` 18% per §10.1 (was 10-15% per §10, repriced 2026-04-27)
3. **Self-host telemetry** — `status: open` (CEO defer,不影响 v1.9 / v2.0 ship)
4. **Free tier on Tangerine Cloud** — `status: ratified` 无 free tier per §10 / §10.1(Day-1 paywall + 30-day no-CC trial 替代 free credit。OSS self-host 永远 $0 是真正的 free path)
5. **Enterprise tier early signaling** — `status: open` (CEO defer,等 reference customer)

## 10. Pricing & License Lock — RATIFIED 2026-04-26

> **SUPERSEDED by 2026-04-27 repricing — see §10.1 below.** Decisions #2, #4, #5 still in force; #1 (Cloud pricing) and #3 (margin floor framing) updated. Table preserved for audit trail.

CEO locked 5 商业模式 decisions in side-chat 2026-04-26 evening:

| # | Decision | Status |
|---|----------|--------|
| 1 | **Cloud pricing**: $5/team/month flat day-1 + 30-day no-CC trial. Plausible-style (NOT Cal.com free-tier). | `superseded 2026-04-27` |
| 2 | **License**: AGPL v3 (OSS) + Dual Commercial License (Cloud / Enterprise / White-label). MongoDB / GitLab pattern. BSL relicensing held in reserve as defensive lever. | `ratified` |
| 3 | **Inference margin**: 30% gross margin floor pre-commit rule + quarterly review. DeepSeek price increase >10% → trigger pricing review. Public messaging: "we commit to 30% margin floor only — overage transparently passed back as price drop." Transparency = trust. | `superseded 2026-04-27` (margin framing now applies to base+overage, not per-token) |
| 4 | **Compliance**: SOC 2 Type II audit by month 6. China data region day-1 (forced by DeepSeek inference being Chinese — natural PIPL / 等保 compliance). ISO 27001 deferred to v2.0+. | `ratified` |
| 5 | **Marketplace launch trigger**: 5,000 OSS installs + 1 self-shipped successful template prototype (e.g. "Tangerine for legal teams" vertical to validate economics). NOT 50k waiting threshold. | `ratified` |

## 10.1 Pricing repricing — RATIFIED 2026-04-27

CEO concluded the prior $5/team/month was confidence-undervaluing the product. Build-in-public + profit-in-public doesn't mean cheap — GitHub Copilot $19/seat, Cursor Pro $20/seat, Linear $8/seat all charge confident prices. $80/team flat for a 5-person team = $16/seat-equivalent vs ChatGPT Team $25/seat — still ~36% cheaper, but 16× revenue per Cloud team for us.

The shared-key + overage structure addresses two problems with pure per-token: (1) users hate "surprise bill at end of month" — a $80 base sets the expectation, overage is rare; (2) DeepSeek wholesale account billing complexity stays our problem, not the customer's.

| # | Decision | Status |
|---|----------|--------|
| 1 | **Cloud pricing repriced**: $5/team/mo → **$80/team/mo flat** + 100M tokens included + overage at $5/10M tokens. Reflects honest value capture; matches GitHub Copilot / Cursor confident pricing. | `ratified 2026-04-27` |
| 2 | **Marketplace take rate**: 10-15% → **18%** (sellers keep 82%). Match Vercel range. | `ratified 2026-04-27` |
| 3 | **Enterprise floor**: $25-100k/yr → **$50-200k/yr**. F500 SaaS contract size. | `ratified 2026-04-27` |
| 4 | **Margin floor**: 30% pre-commit rule unchanged from 2026-04-26 — applies now to base+overage rather than per-token. | `unchanged from 2026-04-26` |

### License transition operational plan

License change Apache-2.0 → AGPL+Commercial is non-trivial (~1 week implementation):

- Update `LICENSE` file (Apache → AGPL v3)
- Add `COMMERCIAL-LICENSE.md` outlining dual-licensing terms
- Update README badges
- Set up CLA flow (cla-assistant.io for GitHub PRs)
- Public announcement (README banner + Twitter)
- Future PR contributor agreement enforcement
- US Inc. → grant ourselves commercial license for Cloud SaaS hosting (avoids AGPL network effect on our own service)

**Timing:** v1.9 final ship cycle, single-week sub-phase. Not blocking SUGGESTION_ENGINE shipment.

### Paywall infrastructure (deferred to v2.0)

Day-1 paywall on Cloud requires (~3 weeks infra):

- Supabase real auth (currently stub mode — any 6-char password signs in locally)
- Stripe subscription billing ($80 flat base + overage credit packs at $5/10M tokens)
- 30-day trial timer + expiry enforcement
- Email verification + IP rate limit (no-CC trial fraud prevention)
- Per-team token meter against shared DeepSeek wholesale key + 100M cap → overage trigger

**Timing:** v2.0 (alongside visualization). v1.9 final ships free OSS still — Cloud is "Coming soon (waitlist)". Existing v1.8.1 / v1.9 OSS users grandfathered to 6-month free Cloud at v2.0 launch (community goodwill).

### SOC 2 ownership

Engineering agents do not handle compliance work. SOC 2 Type II by month 6 requires a named owner:

- **Open question to CEO**: who owns SOC 2 prep? (Founder + Vanta auto / hire compliance lead / external audit firm)
- Without owner, month-6 deadline impossible
- Vanta / Drata / Sprinto are 3 main DIY-compliance platforms (~$10-30k/year)

### Defensive lever in reserve

If AGPL + Dual Commercial fails to block hyperscaler abuse (AWS-style clone), **BSL relicensing** held in reserve (Sentry / HashiCorp pattern). Not Day-1 because BSL pre-ratification alienates community before it forms.

---

*BUSINESS_MODEL_SPEC v1.0 complete. LOCKED 2026-04-26 alongside 立项书 v1.3. Repriced 2026-04-27 (§10.1).*
