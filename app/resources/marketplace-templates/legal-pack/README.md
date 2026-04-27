# Tangerine for Legal Teams

Self-shipped reference vertical for the v3.5 marketplace. Validates the bundle format, the take-rate math, and the 1-click install path before community templates start landing.

## What's in this pack

| File | Purpose |
|---|---|
| `template.json` | Marketplace metadata (id, name, price, take rate, deps, tags) |
| `co-thinker-prompts/` | Legal-context system prompts (contract review, case prep, deposition, plain-language explainer) |
| `sources-config.yaml` | Recommended Slack channels, Notion DBs, Email digests, glob patterns for `.docx` / `.pdf` legal docs |
| `canvas-templates/` | 4 starter canvases: case prep, contract review, motion draft, deposition prep |
| `suggestion-templates/` | Legal-specific rule templates (decision-drift detector, deadline reminders, conflict-of-interest auto-flag) |

## Install

Once the v3.5 marketplace public launch gate is met (5,000 OSS installs over 30 days + ≥1 self-shipped vertical template internally validated for ≥30 days):

```
tangerine template install tangerine-legal-pack
```

Until then, this pack ships bundled in the app under `app/resources/marketplace-templates/legal-pack/` and the install path is the stub mode in `crate::marketplace::install_template` — content is materialized into `~/.tangerine-memory/marketplace/templates/tangerine-legal-pack/` for the user's team.

## Pricing

- First 100 installs: free, in exchange for written feedback (launch testimonials).
- Install 101+: $199 one-time.
- Renewals: free, perpetual updates with original purchase.
- Take rate: 15% (per `BUSINESS_MODEL_SPEC.md` §10 line 5 — paid templates ≥ $50).

## Author

Published under the official `tangerine` author handle, signed with the company GPG key. Different visual treatment in the marketplace listing — "platform-curated."

## Spec

`V3_5_SPEC.md` §3 — First Vertical Template — Self-Ship.

## License

`LicenseRef-Tangerine-Marketplace` — see commercial terms in the v3.5 author agreement.
