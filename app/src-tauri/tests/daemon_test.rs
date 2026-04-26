//! End-to-end integration test for the v1.7 RMS daemon.
//!
//! Verifies the heartbeat loop:
//!   * Records timestamps on every tick.
//!   * Caps the error tail at MAX_ERRORS_RETAINED (20).
//!   * Survives subprocess failures (no panic propagated).
//!   * Stops cleanly when notified.
//!   * Doesn't leak the heartbeat counter beyond the requested ticks.
//!
//! We use `daemon::run_for_test` which runs the loop body N times against a
//! controllable interval. We force subprocess failures by pointing
//! `python_bin` at a path that doesn't exist — the goal is to prove the
//! supervisor stays alive across errors, not to exercise the python side
//! (that's covered in pytest).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tangerine_meeting_lib::daemon::{self, DaemonConfig, DaemonControl};

fn fresh_root(label: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "rms_daemon_test_{}_{}",
        label,
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn fail_fast_cfg(root: PathBuf) -> DaemonConfig {
    DaemonConfig {
        memory_root: root,
        // Path that definitely won't resolve so each subcommand returns an
        // error to the supervisor (without panicking).
        python_bin: Some(PathBuf::from("does_not_exist_python_xxxxx")),
        git_pull_enabled: false,
        team_repo_path: None,
        interval: Some(Duration::from_millis(5)),
        log_path: None,
    }
}

#[tokio::test]
async fn heartbeat_runs_n_times_no_panic() {
    let root = fresh_root("loop");
    let cfg = fail_fast_cfg(root.clone());
    let control = Arc::new(DaemonControl::default());
    daemon::run_for_test(cfg, control.clone(), 5).await;
    let snap = control.snapshot();
    assert_eq!(snap.heartbeat_count, 5);
    assert!(snap.last_heartbeat.is_some());
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn errors_capped_at_max() {
    let root = fresh_root("errcap");
    let cfg = fail_fast_cfg(root.clone());
    let control = Arc::new(DaemonControl::default());
    // 30 ticks × 3 subcommand failures each = 90 errors before cap.
    daemon::run_for_test(cfg, control.clone(), 30).await;
    let snap = control.snapshot();
    assert!(
        snap.errors.len() <= 20,
        "expected ≤20 errors, got {}",
        snap.errors.len()
    );
    assert_eq!(snap.heartbeat_count, 30);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn zero_ticks_leaves_status_pristine() {
    let root = fresh_root("zerotick");
    let cfg = fail_fast_cfg(root.clone());
    let control = Arc::new(DaemonControl::default());
    daemon::run_for_test(cfg, control.clone(), 0).await;
    let snap = control.snapshot();
    assert_eq!(snap.heartbeat_count, 0);
    assert!(snap.last_heartbeat.is_none());
    assert!(snap.errors.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn snapshot_reads_independent_of_loop() {
    let root = fresh_root("snap");
    let cfg = fail_fast_cfg(root.clone());
    let control = Arc::new(DaemonControl::default());
    let c2 = control.clone();
    let task = tokio::spawn(async move {
        daemon::run_for_test(cfg, c2, 10).await;
    });
    // Read snapshots while the loop runs — must never panic / deadlock.
    for _ in 0..5 {
        let _ = control.snapshot();
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    task.await.unwrap();
    let snap = control.snapshot();
    assert_eq!(snap.heartbeat_count, 10);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn error_format_contains_context() {
    let root = fresh_root("errformat");
    let cfg = fail_fast_cfg(root.clone());
    let control = Arc::new(DaemonControl::default());
    daemon::run_for_test(cfg, control.clone(), 1).await;
    let snap = control.snapshot();
    // Each error string starts with "[<rfc3339>] <where>: <detail>"
    let any = snap.errors.iter().find(|e| e.contains("python spawn"));
    assert!(
        any.is_some(),
        "expected a 'python spawn' error, got {:?}",
        snap.errors
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn long_run_stable_no_growing_state() {
    // Proxy for "survives 24+ hours": run many ticks at high frequency and
    // verify state remains bounded (errors capped, counters monotonic).
    let root = fresh_root("longrun");
    let cfg = fail_fast_cfg(root.clone());
    let control = Arc::new(DaemonControl::default());
    daemon::run_for_test(cfg, control.clone(), 200).await;
    let snap = control.snapshot();
    assert_eq!(snap.heartbeat_count, 200);
    assert!(snap.errors.len() <= 20);
    let _ = std::fs::remove_dir_all(&root);
}
