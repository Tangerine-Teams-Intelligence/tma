---
sample: true
date: 2026-04-26
title: Raise paid pricing $20 → $24/seat
status: decided
attendees: [sam, jess]
source: meeting
source_id: sample-2026-04-26-pricing
references:
  - timeline/2026-04-26.md
  - threads/jess-competitor-scan
---

## Decision

Raise paid pricing from **$20/seat/month** to **$24/seat/month** for new
signups, effective 2026-04-26. Existing accounts grandfathered at $20
through 2026-12-31.

## Rationale

- Jess's competitor scan: 4 of 6 comparable tools sit at $25–$30/seat.
  We were under-priced by ~20%.
- Trial-to-paid conversion has been steady at 12% for 6 weeks. We have
  pricing room before conversion drops.
- Existing-account grandfathering keeps the trust signal intact for the
  team customers we already have.

## Watch

- Trial conversion (target: stay above 10%, currently 12%).
- Median ARPU (target: lift 15–20% inside 60 days).
- Inbound complaint volume (target: < 5 angry tickets/month).

## Action items

- [ ] Sam: ship the pricing-page update + Stripe price object by EOD.
- [ ] Jess: write the customer-facing FAQ; Sam to review.
- [ ] Re-evaluate on 2026-06-26 with full 60-day data.
