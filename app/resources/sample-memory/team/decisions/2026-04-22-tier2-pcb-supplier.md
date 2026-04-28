---
sample: true
date: 2026-04-22
title: Tier-2 PCB supplier — 兴森 over 依顿/胜宏
status: decided
attendees: [alex, sam, jess]
source: meeting
source_id: sample-2026-04-22-supplier-review
references:
  - timeline/2026-04-22.md
  - threads/jess-competitor-scan
---

## Decision

Lock **兴森 (Shennan Circuits)** as our Tier-2 PCB supplier for the v2
hardware run, with **依顿** held as the explicit backup if 兴森's delivery
slips inside our 4-week lead window.

## Rationale

- **Lead time**: 兴森 confirmed 21 days end-to-end vs 依顿's 23 days and
  胜宏's 26 days. We need parts in hand by 2026-05-20 for the v2 build.
- **Price**: All three quoted within 6% of each other; 兴森 was the
  lowest at $4.10/board for our 8-layer spec.
- **Quality history**: 兴森 has shipped to two of our reference designs
  before with zero RMA's. 胜宏 is unproven on our spec.
- **Backup plan**: If 兴森 hits a delivery snag, 依顿 confirmed they can
  step in with a 23-day cycle on 48h notice.

## Action items

- [ ] Sam: send the formal PO to 兴森 by 2026-04-25.
- [ ] Alex: ping 依顿 monthly so they keep capacity warm.
- [ ] Jess: track 兴森's first-batch yield and feed back to the channel.
