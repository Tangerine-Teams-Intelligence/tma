# Daemon brief-trigger hook

The Rust daemon (`app/src-tauri/src/daemon.rs`) shells out to subcommands
each heartbeat. To register the calendar source's pre-meeting brief trigger,
add this case to `do_heartbeat()` in daemon.rs:

```rust
// 6. Pre-meeting brief check — calendar source.
if let Err(e) = run_node_subcommand(cfg, "tangerine-calendar", &["briefs"]).await {
    control.record_error("calendar_briefs", e);
}
```

Where `run_node_subcommand` is the analog of `run_python_subcommand_with_args`
that invokes `node <path>/sources/calendar/dist/cli.js` instead of `python -m
tmi.daemon_cli`. Stdout from `tangerine-calendar briefs` is the trigger list:

```
2030-06-01T16:00:00.000Z  T-3m  Investor pitch — Acme Ventures  [ical-x]
```

Empty stdout → no triggers, no notification. Each non-empty line should be
surfaced as an OS notification + push the composed brief markdown
(`briefForEvent()` on the calendar `index.ts` exports) into
`<memory>/.tangerine/briefs/pre-meeting/<slug>.md` for the UI to render.

## Stage 1 minimum (what to ship now)

Until the Rust daemon ships the new subcommand path, the calendar CLI's
`watch` verb already runs the polling loop standalone. Add a one-line bash
wrapper to the daemon's startup script:

```bash
node sources/calendar/dist/cli.js watch &
```

The CEO can run that alongside `tangerine-slack watch &` for now. The Rust
daemon integration lands in v1.7.1.

## What changed

- `tangerine-calendar briefs` is the trigger probe (idempotent, fast).
- `pollBriefTriggers` (exported from `index.ts`) is the programmatic surface
  if the daemon prefers in-process invocation via a Node bridge.
- `briefForEvent` composes the Stage 1 keyword-match brief markdown.
- All three of the above are unit-tested (see `tests/briefs.test.ts`).
