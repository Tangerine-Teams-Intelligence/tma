---
date: 2026-04-25
title: Postgres over Mongo for v1 backend
source: meeting
source_id: sample-2026-04-25-roadmap-sync
source_line: 7
status: decided
sample: true
---

## Decision

Use **Postgres** for v1 backend, not Mongo.

## Context

Schema flexibility of Mongo not worth it for our access patterns. Postgres ecosystem (better tooling, JSONB when needed) wins.

## Provenance

- From: [meetings/sample-2026-04-25-roadmap-sync.md L7](../meetings/sample-2026-04-25-roadmap-sync.md#L7)
