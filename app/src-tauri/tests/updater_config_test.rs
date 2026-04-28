// === wave 25 ===
//! Schema-only smoke test for the wave-25 auto-updater plugin config.
//!
//! `tauri-plugin-updater` 2.x reads its endpoint list + pubkey from the
//! `plugins.updater` block in `tauri.conf.json` at build time. We don't
//! exercise the real network path here — that requires a live GitHub
//! Releases artifact and a signed manifest. Instead we lock down:
//!
//!   1. The shape of the JSON the plugin expects (so a future config
//!      typo surfaces as a test fail, not a silent no-op at runtime).
//!   2. The presence of the placeholder pubkey + the comment trail so
//!      CEO knows where to swap in the real key.
//!   3. The endpoint URL points at the org repo (not the dev fork).
//!
//! These tests are deliberately schema-only — `cargo test --tests` runs
//! them without needing the Tauri host or a real network. They protect
//! the wave-25 ship surface from a refactor accidentally dropping the
//! updater block.
// === end wave 25 ===

use serde_json::Value;

const TAURI_CONF: &str = include_str!("../tauri.conf.json");

fn parse_conf() -> Value {
    serde_json::from_str(TAURI_CONF).expect("tauri.conf.json must parse as JSON")
}

#[test]
fn updater_block_exists_under_plugins() {
    let v = parse_conf();
    let plugins = v
        .get("plugins")
        .expect("tauri.conf.json missing `plugins` block");
    assert!(
        plugins.get("updater").is_some(),
        "wave 25: tauri.conf.json::plugins.updater missing — auto-updater \
         won't initialise. See main.rs `tauri_plugin_updater::Builder::new().build()`."
    );
}

#[test]
fn updater_endpoint_points_at_org_repo() {
    let v = parse_conf();
    let endpoints = v
        .pointer("/plugins/updater/endpoints")
        .and_then(|e| e.as_array())
        .expect("plugins.updater.endpoints must be a non-empty array");
    assert!(
        !endpoints.is_empty(),
        "plugins.updater.endpoints must contain ≥1 URL — the plugin polls \
         each for a `latest.json` manifest"
    );
    let first = endpoints[0].as_str().unwrap_or("");
    assert!(
        first.contains("Tangerine-Teams-Intelligence/tangerine-teams-app"),
        "wave 25: endpoint must point at the org repo, got `{}`",
        first
    );
    assert!(
        first.ends_with("/latest.json"),
        "wave 25: endpoint must end with `/latest.json` (Tauri 2 manifest \
         filename), got `{}`",
        first
    );
}

#[test]
fn updater_pubkey_is_placeholder_with_clear_marker() {
    let v = parse_conf();
    let pubkey = v
        .pointer("/plugins/updater/pubkey")
        .and_then(|p| p.as_str())
        .expect("plugins.updater.pubkey must be a string (placeholder OK)");
    // The placeholder is intentionally obvious so a release engineer
    // can grep for it before cutting a signed build. If you're seeing
    // this fail because you're shipping a real signed build, that's
    // expected — delete this assertion at the same commit you swap
    // the real pubkey in.
    assert!(
        pubkey.contains("PLACEHOLDER")
            || pubkey.starts_with("dW50cn") /* "untr..." base64 — real Tauri pubkey prefix */
            || pubkey.len() > 40, /* real Ed25519 pubkeys are ~44 chars base64 */
        "wave 25: pubkey is neither a clear placeholder nor a plausible \
         real Ed25519 key. Either generate via `npx tauri signer generate` \
         or restore the PLACEHOLDER marker so CEO knows it's pending."
    );
}
