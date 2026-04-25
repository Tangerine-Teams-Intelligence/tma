//! Integration test for the IPC subprocess pipeline.
//!
//! We don't spin up a real Tauri app here (that would need a windowing
//! context). Instead we drive the lower-level `runner::run_oneshot` against
//! the frozen Python binary at the canonical resource path and assert that:
//!   1. the binary is present (build_python.ps1 was run);
//!   2. `--help` exits 0;
//!   3. stdout decodes as UTF-8 even though the parent path is non-ASCII.
//!
//! Run with: `cargo test --manifest-path app/src-tauri/Cargo.toml -- --ignored`
//! (ignored by default so unit `cargo test` doesn't require a built bundle).

use std::path::PathBuf;

#[tokio::test]
#[ignore]
async fn frozen_python_help_runs() {
    use tangerine_meeting_lib::commands::runner::run_oneshot;

    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../resources/python/python.exe");
    assert!(
        p.is_file(),
        "expected frozen python at {:?}; run scripts/build_python.ps1 first",
        p
    );

    let (status, stdout, stderr) = run_oneshot(&p, &["--help"], None).await.unwrap();
    assert!(
        status.success(),
        "tmi --help failed: {:?}\nstdout: {}\nstderr: {}",
        status,
        stdout,
        stderr
    );
    assert!(
        stdout.contains("tmi") || stdout.to_lowercase().contains("usage"),
        "unexpected stdout: {}",
        stdout
    );
}

#[tokio::test]
#[ignore]
async fn frozen_python_handles_non_ascii_cwd() {
    use tangerine_meeting_lib::commands::runner::run_oneshot;

    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("../resources/python/python.exe");
    assert!(p.is_file());

    // Use repo root as cwd — on the target machine this is
    // C:\Users\daizhe zo\Desktop\meeting-live\ (space + 'zo' = non-ASCII).
    let mut cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    cwd.push("../..");

    let (status, _stdout, stderr) = run_oneshot(&p, &["--help"], Some(&cwd)).await.unwrap();
    assert!(
        status.success(),
        "tmi --help failed in cwd {:?}: stderr={}",
        cwd, stderr
    );
}
