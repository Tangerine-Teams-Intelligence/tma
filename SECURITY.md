# Security Policy

## Supported versions

TMA is pre-1.0. Only `main` is supported. We don't backport fixes to tagged versions yet.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

Email: security@tangerineintelligence.ai

Include:
- Affected component (CLI, bot, adapter, observer prompt)
- Reproduction steps or PoC
- Your assessment of impact
- Whether you want credit (and under what name) in the fix notes

### Response timeline

- **Acknowledgment**: within 7 days
- **Triage + severity assignment**: within 14 days
- **Fix or mitigation plan**: within 30 days for high/critical
- **Public disclosure**: 90 days from acknowledgment, or when a fix ships, whichever is sooner

We coordinate disclosure with reporters. If you need to publish sooner (e.g. CVE filing), let us know and we'll work with the timeline.

## Scope

In scope:
- The `tmi` Python CLI (`src/tmi/`)
- The Discord bot (`bot/`)
- Observer prompts and their handling of untrusted transcript input
- The Claude Code output adapter's file-write and git-commit paths
- Sample configs and docs that could mislead users into insecure setups

Out of scope:
- Vulnerabilities in third-party dependencies (report upstream; we'll bump versions)
- The Discord platform itself
- The OpenAI Whisper API
- The `claude` CLI
- Your target repo's contents after `tmi apply` (we only write what you approve)

## Sensitive data

TMA processes audio and transcripts that may contain confidential business discussion. Security-relevant notes:

- Bot tokens and API keys are read from environment variables, never written to meeting artifacts. If you find a code path where they leak, that's a bug.
- Transcripts land in a local git repo (`meetings_repo`). Treat that repo's access control as you would any other sensitive repo.
- The `claude` observer subprocess receives transcript + ground truth on stdin. It runs locally under your user account. No network egress beyond what the `claude` CLI itself does.
- Whisper API calls send audio chunks to OpenAI. If your meeting content is too sensitive for that, don't use v1 — a local Whisper backend is on the roadmap for v1.2.

## Safe harbor

We won't pursue legal action against researchers who:
- Make a good-faith effort to avoid privacy violations, data destruction, and service disruption
- Only interact with accounts/repos they own or have permission to test
- Give us reasonable time to fix issues before public disclosure
