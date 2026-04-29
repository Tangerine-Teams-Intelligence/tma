//! v1.15.2 Fix #5 — End-to-end spawn-and-handshake integration test.
//!
//! This test would have caught v1.15.1's `TANGERINE_MCP_TOOL_ID` regression.
//! Run with `cargo test --test spawn_handshake_e2e` after any changes to
//! `commands/setup_wizard.rs` (especially the env-var construction in
//! `auto_configure_mcp` / `v15_configure_mcp_editor`) or to
//! `agi/sampling_bridge.rs` / `ws_server.rs`.
//!
//! Why this test exists
//! --------------------
//! v1.15.0 + v1.15.1 shipped with mock-only test coverage of the editor
//! auto-configuration flow: every existing test asserted on a JSON blob
//! we wrote to `~/.claude.json` / `~/.cursor/mcp.json` / `~/.codex/config.toml`,
//! none of them actually spawned `npx tangerine-mcp@^0.1.0` and verified
//! it phoned home with the correct `tool_id`. As a result, a wrong
//! env-var value (e.g. omitting `TANGERINE_MCP_TOOL_ID`, defaulting all
//! editors to `"cursor"`) silently passed CI and `mcp_server_handshake`
//! returned `false` for every editor except cursor in the wild.
//!
//! What it does
//! ------------
//! Each scenario:
//!   1. Picks a clean ephemeral port (NOT 7780 — would clash with a
//!      running app instance during local dev).
//!   2. Boots the same `ws_server::run_accept_loop_for_test` that the
//!      production `ws_server::start` uses, on that port.
//!   3. Spawns a real `npx -y tangerine-mcp@^0.1.0` child process with
//!      the env vars under test (`TANGERINE_SAMPLING_BRIDGE=1`,
//!      `TANGERINE_PORT=<ephemeral>`, optionally `TANGERINE_MCP_TOOL_ID`).
//!   4. Polls `sampling_bridge::global().has(<tool_id>)` for up to ~15 s
//!      (npm download + node startup is slow on cold caches).
//!   5. Asserts the registration matches the spec.
//!   6. Cleans up: kills the child, signals the ws_server stop, and
//!      deregisters the tool_id from the global registry so the next
//!      scenario starts clean.
//!
//! Skip-conditions
//! ---------------
//! Tests skip cleanly with a printed reason if `npx` is not on `$PATH`.
//! CI machines have node installed; dev machines should too. To force-skip
//! all of these (e.g. on a flaky network), build without the `e2e_spawn`
//! feature and use `--skip` instead — but the default is "run if node
//! is available" because the whole point is to catch regressions a
//! mock-test would miss.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::net::TcpListener;
use tokio::process::{Child, Command};
use tokio::sync::Notify;

use tangerine_meeting_lib::agi::sampling_bridge;
use tangerine_meeting_lib::commands::setup_wizard::mcp_server_handshake;
use tangerine_meeting_lib::ws_server;

// ---------------------------------------------------------------------------
// Skip plumbing
// ---------------------------------------------------------------------------

/// Resolve the platform-specific npx binary name.
///
/// Windows ships npm tools as `.cmd` shims that are NOT auto-resolved by
/// `std::process::Command::new("npx")` — only the cmd.exe shell does that
/// resolution. So on Windows we explicitly probe `npx.cmd`. On Unix `npx`
/// is a real script and works as-is.
fn npx_binary() -> &'static str {
    #[cfg(windows)]
    {
        "npx.cmd"
    }
    #[cfg(not(windows))]
    {
        "npx"
    }
}

/// True iff `npx` resolves on `$PATH`. We probe with `--version` because it
/// exits 0 fast (no network). `which` crate isn't in our dep tree and we
/// don't want to add one for a single use site.
fn npx_available() -> bool {
    std::process::Command::new(npx_binary())
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Macro form of `if !npx_available() { eprintln!(...); return; }`. Lets each
/// `#[tokio::test]` body open with one line.
macro_rules! require_npx {
    () => {
        if !npx_available() {
            eprintln!(
                "spawn_handshake_e2e: skipping — `npx` not on PATH. \
                 Install Node.js >= 20 to enable this end-to-end test."
            );
            return;
        }
    };
}

// ---------------------------------------------------------------------------
// Per-scenario harness
// ---------------------------------------------------------------------------

/// Bind an ephemeral port and start the same accept loop ws_server uses in
/// production. Returns `(port, stop_notify)`. The caller is responsible for
/// calling `stop.notify_waiters()` during cleanup.
///
/// We deliberately do NOT use the `7780..=7790` fallback range so that a
/// running Tangerine app on the dev machine doesn't collide with the test
/// listener. The spawned `tangerine-mcp` child is told the real port via
/// `TANGERINE_PORT`, which the published `0.1.0` bridge honors verbatim
/// (see `mcp-server/src/sampling-bridge.ts::discoverTangerinePort`).
async fn start_bridge_on_ephemeral_port() -> (u16, Arc<Notify>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port for sampler bridge");
    let port = listener
        .local_addr()
        .expect("local_addr on ephemeral listener")
        .port();
    let stop = Arc::new(Notify::new());
    let stop_clone = stop.clone();
    let ctx = ws_server::WsServerCtx {
        solo_root: std::env::temp_dir(),
        app_data_dir: std::env::temp_dir(),
        team_repo_path: Arc::new(parking_lot::Mutex::new(None)),
    };
    tokio::spawn(async move {
        ws_server::run_accept_loop_for_test(listener, ctx, stop_clone).await;
    });
    // Tiny pause so the listener has definitely entered `accept()`.
    tokio::time::sleep(Duration::from_millis(20)).await;
    (port, stop)
}

/// Spawn `npx -y tangerine-mcp@^0.1.0` with the bridge enabled and the
/// supplied tool_id (or default-cursor when `tool_id_override = None`).
///
/// Inherits `PATH` from the parent so npx can find node. stdio is piped to
/// /dev/null-ish: stdout is the MCP stdio channel (we never write to it,
/// the child will block waiting for `initialize` JSON-RPC, which is fine —
/// we only care about the bridge ws connection happening in parallel).
fn spawn_tangerine_mcp(
    port: u16,
    tool_id_override: Option<&str>,
) -> std::io::Result<Child> {
    let mut cmd = Command::new(npx_binary());
    cmd.arg("-y")
        .arg("tangerine-mcp@^0.1.0")
        .env("TANGERINE_SAMPLING_BRIDGE", "1")
        .env("TANGERINE_PORT", port.to_string())
        // Faster reconnect during tests so we don't eat 1s on the first
        // attempt. Bridge picks this up unconditionally (see
        // `RECONNECT_INITIAL_MS` in sampling-bridge.ts).
        .env("TANGERINE_SAMPLING_RECONNECT_MS", "100")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(t) = tool_id_override {
        cmd.env("TANGERINE_MCP_TOOL_ID", t);
    }
    // Suppress the flash of cmd.exe when running interactively on Windows.
    // tokio::process::Command exposes the inner std command via `as_std_mut()`
    // so we can apply the CommandExt method without converting types.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// Poll `registry.has(tool_id)` every 100 ms until true or `deadline`
/// elapses. Returns `true` if registration succeeded within the window.
async fn wait_for_registration(tool_id: &str, max: Duration) -> bool {
    let registry = sampling_bridge::global();
    let started = Instant::now();
    while started.elapsed() < max {
        if registry.has(tool_id) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// RAII guard for a single scenario. On drop:
///   * Sends SIGKILL (or Windows TerminateProcess) to the child.
///   * Notifies the ws_server to break its accept loop.
///   * Deregisters the tool_id from the process-wide bridge registry so
///     the next scenario in the same test binary starts clean.
///
/// Constructed with `Scenario::new(...)` and dropped at end of scope.
/// Cleanup is best-effort by design — a leaked test process would surface
/// as a port collision the next run, which the ephemeral-port harness
/// avoids by construction anyway.
struct Scenario {
    child: Option<Child>,
    stop: Arc<Notify>,
    tool_ids_to_purge: Vec<&'static str>,
}

impl Scenario {
    fn new(child: Child, stop: Arc<Notify>, tool_ids_to_purge: Vec<&'static str>) -> Self {
        Self {
            child: Some(child),
            stop,
            tool_ids_to_purge,
        }
    }
}

impl Drop for Scenario {
    fn drop(&mut self) {
        // 1. Kill the npx subprocess + every descendant.
        //
        //    On Unix, `start_kill()` (SIGKILL to PID) plus `kill_on_drop`
        //    is sufficient because tokio puts the child in its own pgrp
        //    and SIGKILL to a pgrp leader cascades.
        //
        //    On Windows there is no pgrp concept and `npx.cmd` spawns a
        //    chain of cmd.exe -> npm-cli.js -> tangerine-mcp/cli.js. Killing
        //    the cmd.exe parent leaves the node grandchildren orphaned and
        //    happily reconnecting to ws://127.0.0.1:<port>/sampler — a
        //    process leak. We use `taskkill /F /T /PID` (force, tree) to
        //    sweep the whole subtree. start_kill() is still called to set
        //    the right exit semantics for tokio's reaper.
        if let Some(mut child) = self.child.take() {
            #[cfg(windows)]
            {
                if let Some(pid) = child.id() {
                    // Best-effort tree kill. Stdin/stdout swallowed so a
                    // missing taskkill (impossible on Win) doesn't pollute
                    // test output.
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/T", "/PID", &pid.to_string()])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                }
            }
            let _ = child.start_kill();
        }
        // 2. Tell the ws_server accept loop to exit at next iteration.
        self.stop.notify_waiters();
        // 3. Scrub the global registry so the next scenario sees a clean
        //    slot for both `cursor` and `claude-code`.
        let registry = sampling_bridge::global();
        for t in &self.tool_ids_to_purge {
            registry.deregister(t);
        }
    }
}

/// Always-deregister both tool_ids before a scenario starts. Earlier tests
/// (or earlier scenarios in the same binary) may have left stale state.
fn purge_global_registry() {
    let registry = sampling_bridge::global();
    registry.deregister("cursor");
    registry.deregister("claude-code");
}

// 15 s registration deadline. Cold `npx -y` on an empty cache routinely
// takes 8-12 s while it downloads tangerine-mcp + its 4 deps; warm runs
// land in <1 s. We set the budget high so flaky CI doesn't blame the test.
const REGISTRATION_DEADLINE: Duration = Duration::from_secs(15);

// ---------------------------------------------------------------------------
// Scenario 1: explicit TOOL_ID=claude-code → registry.has("claude-code")
// ---------------------------------------------------------------------------

/// Spec-mandated. Asserts that when the editor wires
/// `TANGERINE_MCP_TOOL_ID=claude-code` into the spawned mcp config (as
/// v1.15.2 does for Claude Code), the bridge registers under `claude-code`
/// — NOT under the default `cursor`. This is the regression v1.15.1 had.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spawn_with_correct_tool_id_registers_in_bridge() {
    require_npx!();
    purge_global_registry();
    let (port, stop) = start_bridge_on_ephemeral_port().await;

    let child = match spawn_tangerine_mcp(port, Some("claude-code")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("spawn_handshake_e2e: skipping — failed to spawn npx: {e}");
            stop.notify_waiters();
            return;
        }
    };
    let _scenario = Scenario::new(child, stop, vec!["cursor", "claude-code"]);

    let registered =
        wait_for_registration("claude-code", REGISTRATION_DEADLINE).await;
    assert!(
        registered,
        "tangerine-mcp@^0.1.0 spawned with TANGERINE_MCP_TOOL_ID=claude-code \
         did not register within {:?}. Either the env-var plumbing in \
         setup_wizard.rs is broken, or the published npm package is older \
         than 0.1.0 (no bridge support).",
        REGISTRATION_DEADLINE
    );

    // Sanity: it should NOT have also registered as cursor (would mean the
    // bridge ignored the env var and double-defaulted).
    assert!(
        !sampling_bridge::global().has("cursor"),
        "bridge registered as cursor despite TANGERINE_MCP_TOOL_ID=claude-code \
         being set — env var was ignored"
    );
}

// ---------------------------------------------------------------------------
// Scenario 2: no TOOL_ID → defaults to "cursor" (documented behavior)
// ---------------------------------------------------------------------------

/// Documented-behavior test, NOT a good-behavior test. The published bridge
/// defaults `TANGERINE_MCP_TOOL_ID` to `"cursor"` for back-compat. If we
/// ever change that default, this test catches it — at which point the
/// owner should consciously update the assertion.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spawn_without_tool_id_defaults_to_cursor() {
    require_npx!();
    purge_global_registry();
    let (port, stop) = start_bridge_on_ephemeral_port().await;

    let child = match spawn_tangerine_mcp(port, None) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("spawn_handshake_e2e: skipping — failed to spawn npx: {e}");
            stop.notify_waiters();
            return;
        }
    };
    let _scenario = Scenario::new(child, stop, vec!["cursor", "claude-code"]);

    let registered = wait_for_registration("cursor", REGISTRATION_DEADLINE).await;
    assert!(
        registered,
        "tangerine-mcp@^0.1.0 spawned without TANGERINE_MCP_TOOL_ID did not \
         register as 'cursor' within {:?}. The npm package's documented \
         default has changed — update the assertion or the docs.",
        REGISTRATION_DEADLINE
    );
}

// ---------------------------------------------------------------------------
// Scenario 3: handshake returns true after a real registration
// ---------------------------------------------------------------------------

/// Wires scenarios 1 + the production `mcp_server_handshake` command end to
/// end. Exercises the same code path the SetupWizard React component calls
/// when the user clicks "Test channel".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mcp_server_handshake_returns_true_after_registration() {
    require_npx!();
    purge_global_registry();
    let (port, stop) = start_bridge_on_ephemeral_port().await;

    let child = match spawn_tangerine_mcp(port, Some("claude-code")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("spawn_handshake_e2e: skipping — failed to spawn npx: {e}");
            stop.notify_waiters();
            return;
        }
    };
    let _scenario = Scenario::new(child, stop, vec!["cursor", "claude-code"]);

    let registered =
        wait_for_registration("claude-code", REGISTRATION_DEADLINE).await;
    assert!(
        registered,
        "precondition failed: claude-code did not register within {:?}",
        REGISTRATION_DEADLINE
    );

    let alive = mcp_server_handshake("claude-code".to_string())
        .await
        .expect("mcp_server_handshake should succeed for known tool_id");
    assert!(
        alive,
        "mcp_server_handshake('claude-code') returned false even though the \
         bridge registered — the command is reading the wrong registry"
    );
}

// ---------------------------------------------------------------------------
// Scenario 4: handshake for a different tool_id returns false (mismatch)
// ---------------------------------------------------------------------------

/// Negative coverage: a registration for `claude-code` must NOT cause
/// `handshake("cursor")` to return true. Catches a future bug where the
/// handshake collapses all editors to a single shared slot.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mcp_server_handshake_returns_false_for_wrong_tool_id() {
    require_npx!();
    purge_global_registry();
    let (port, stop) = start_bridge_on_ephemeral_port().await;

    let child = match spawn_tangerine_mcp(port, Some("claude-code")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("spawn_handshake_e2e: skipping — failed to spawn npx: {e}");
            stop.notify_waiters();
            return;
        }
    };
    let _scenario = Scenario::new(child, stop, vec!["cursor", "claude-code"]);

    let registered =
        wait_for_registration("claude-code", REGISTRATION_DEADLINE).await;
    assert!(
        registered,
        "precondition failed: claude-code did not register within {:?}",
        REGISTRATION_DEADLINE
    );

    let alive = mcp_server_handshake("cursor".to_string())
        .await
        .expect("mcp_server_handshake should succeed for known tool_id");
    assert!(
        !alive,
        "mcp_server_handshake('cursor') returned true while only claude-code \
         is registered — the handshake is collapsing tool_ids"
    );
}
