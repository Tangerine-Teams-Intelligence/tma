// === wave 16 ===
//! Wave 16 — Tauri command surface for the activity event bus.
//!
//! Single command:
//!   * `activity_recent { limit?: usize }` → `Vec<ActivityAtomEvent>`
//!     newest-first. Reads from the in-memory ring buffer in
//!     `crate::activity`. The ring survives across short-lived Tauri
//!     command invocations (it's a process-wide `Lazy<Mutex<…>>`) so the
//!     React `<ActivityFeed/>` mount path can hydrate without polling.
//!
//! The frontend wires this in `app/src/lib/tauri.ts::activityRecent`.
//! On mount it both calls this command (initial paint) AND subscribes to
//! the `activity:atom_written` Tauri event for live updates.

use crate::activity::{snapshot, ActivityAtomEvent};
use crate::commands::AppError;

/// Fetch the most recent N activity events from the in-memory ring.
/// Default `limit = 50` (the buffer cap). Returns newest-first.
#[tauri::command]
pub async fn activity_recent(limit: Option<usize>) -> Result<Vec<ActivityAtomEvent>, AppError> {
    Ok(snapshot(limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::{
        _clear_ring_for_tests, record_atom_written_no_emit, ActivityAtomEvent, AtomKind,
        TEST_LOCK,
    };

    /// Same serialization helper as `activity::tests` — the ring is a
    /// process-wide singleton; parallel cargo workers must not stomp.
    /// We use a sync lock + `block_on`-friendly closure pattern so the
    /// `#[tokio::test]` async runtime stays clean.
    async fn _serialised<F, Fut>(f: F)
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let _g = TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        _clear_ring_for_tests();
        f().await;
    }

    #[tokio::test]
    async fn returns_empty_when_ring_clean() {
        _serialised(|| async {
            let r = activity_recent(Some(10)).await.unwrap();
            assert!(r.is_empty());
        })
        .await;
    }

    #[tokio::test]
    async fn returns_reverse_chrono() {
        _serialised(|| async {
            let tmp = std::env::temp_dir().join(format!(
                "tii_w16_cmd_{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&tmp).unwrap();
            for i in 0..5 {
                record_atom_written_no_emit(
                    &tmp,
                    ActivityAtomEvent::new(format!("a{i}.md"), format!("e{i}"), AtomKind::Decision),
                );
            }
            let r = activity_recent(Some(3)).await.unwrap();
            assert_eq!(r.len(), 3);
            assert_eq!(r[0].title, "e4"); // newest first
            assert_eq!(r[1].title, "e3");
            assert_eq!(r[2].title, "e2");
            let _ = std::fs::remove_dir_all(&tmp);
        })
        .await;
    }

    #[tokio::test]
    async fn caps_at_buffer_size_when_limit_oversized() {
        _serialised(|| async {
            let tmp = std::env::temp_dir().join(format!(
                "tii_w16_cmd2_{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&tmp).unwrap();
            for i in 0..10 {
                record_atom_written_no_emit(
                    &tmp,
                    ActivityAtomEvent::new(format!("a{i}.md"), format!("e{i}"), AtomKind::Thread),
                );
            }
            // Asking for 9999 must NOT panic; capped at RING_BUFFER_CAP.
            let r = activity_recent(Some(9999)).await.unwrap();
            assert_eq!(r.len(), 10);
        })
        .await;
    }

    #[tokio::test]
    async fn default_limit_returns_all_buffer() {
        _serialised(|| async {
            let tmp = std::env::temp_dir().join(format!(
                "tii_w16_cmd3_{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&tmp).unwrap();
            for i in 0..7 {
                record_atom_written_no_emit(
                    &tmp,
                    ActivityAtomEvent::new(
                        format!("a{i}.md"),
                        format!("e{i}"),
                        AtomKind::BrainUpdate,
                    ),
                );
            }
            let r = activity_recent(None).await.unwrap();
            assert_eq!(r.len(), 7);
            assert_eq!(r[0].title, "e6");
            let _ = std::fs::remove_dir_all(&tmp);
        })
        .await;
    }
}
// === end wave 16 ===
