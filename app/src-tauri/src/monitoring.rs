//! Wave 3 cross-cut — SOC 2 §9 "Monitoring" control.
//!
//! Per OBSERVABILITY_SPEC §9: "Uptime + error rate dashboard for cloud-side
//! services (auth, billing webhook). Internal-only Grafana initially." This
//! module is the engineering-side counter / ledger for that dashboard. Stub
//! mode by default — counters live in-process; the production cut will tee
//! to a self-host Grafana / Prometheus endpoint once the cloud side
//! ratifies a destination (open question §11 Q1 in the spec).
//!
//! Three signals tracked:
//!   * `heartbeat_ok`        — daemon emitted a heartbeat without panicking.
//!   * `error_rate`          — error count over a rolling 1-hour window.
//!   * `latency_ms` (per op) — recent samples, p95-able for SLO checks.
//!
//! Privacy: counters carry op names + integer counts. No payloads, no atom
//! paths, no user identifiers — the monitoring stream is operational, not
//! observational. Distinct from `agi/telemetry.rs` (action observation) and
//! `audit_log.rs` (privileged-action ledger).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Rolling-window cap. We only ever keep the most recent 4_096 samples;
/// older entries fall off as new ones arrive. 4 KiB per sample is plenty
/// for a single-process desktop app — the cloud side will own its own
/// retention when this gets teed there.
const SAMPLE_CAP: usize = 4_096;

/// Process-lifetime monitor singleton. `OnceLock` would be cleaner once
/// the MSRV bump lands; for now a static `Mutex<Option<...>>` keeps the
/// tree dep-free.
static MONITOR: Mutex<Option<Monitor>> = Mutex::new(None);

/// Heartbeat counter. Atomic so the daemon's tick can bump without taking
/// the monitor mutex on the hot path.
static HEARTBEAT_OK_COUNT: AtomicU64 = AtomicU64::new(0);
/// Cumulative error counter. Bump from any error-handler boundary.
static ERROR_COUNT: AtomicU64 = AtomicU64::new(0);

/// One latency sample bound to an op name and a wall-clock instant.
#[derive(Debug, Clone)]
pub struct LatencySample {
    pub op: &'static str,
    pub recorded_at: Instant,
    pub elapsed: Duration,
}

/// Single-process monitor state. Cheap to construct and Drop — no IO.
pub struct Monitor {
    samples: VecDeque<LatencySample>,
    started_at: Instant,
}

impl Monitor {
    pub fn new() -> Self {
        Self {
            samples: VecDeque::with_capacity(64),
            started_at: Instant::now(),
        }
    }

    /// Insert a latency sample. Drops the oldest entry when over cap.
    pub fn record_latency(&mut self, op: &'static str, elapsed: Duration) {
        if self.samples.len() == SAMPLE_CAP {
            self.samples.pop_front();
        }
        self.samples.push_back(LatencySample {
            op,
            recorded_at: Instant::now(),
            elapsed,
        });
    }

    /// Snapshot of stats over the last `window`. Returns `(count, p95)`
    /// for the named op; `count == 0` means "no recent samples." Uses
    /// `Instant::now()` as the right edge so the caller doesn't have to
    /// thread a clock argument in.
    pub fn op_stats(&self, op: &'static str, window: Duration) -> (usize, Duration) {
        let cutoff = Instant::now() - window;
        let mut latencies: Vec<Duration> = self
            .samples
            .iter()
            .filter(|s| s.op == op && s.recorded_at >= cutoff)
            .map(|s| s.elapsed)
            .collect();
        if latencies.is_empty() {
            return (0, Duration::ZERO);
        }
        latencies.sort();
        let idx = ((latencies.len() as f64) * 0.95).floor() as usize;
        let idx = idx.min(latencies.len() - 1);
        (latencies.len(), latencies[idx])
    }

    /// Wall time since this monitor was constructed. Proxy for "process
    /// uptime" until a real cloud-side dashboard inherits the metric.
    pub fn uptime(&self) -> Duration {
        self.started_at.elapsed()
    }
}

/// Initialise the singleton if it isn't already. Idempotent — the second
/// call is a no-op so the daemon and tests can both call it freely.
pub fn init() {
    let mut g = MONITOR.lock().expect("monitor mutex poisoned");
    if g.is_none() {
        *g = Some(Monitor::new());
    }
}

/// Bump the OK-heartbeat counter. Cheap — no lock held.
pub fn record_heartbeat_ok() {
    HEARTBEAT_OK_COUNT.fetch_add(1, Ordering::Relaxed);
}

/// Bump the error counter. Call this from any error-boundary that
/// surfaces a user-visible problem (per OBSERVABILITY_SPEC §3 the same
/// place that emits a tracing `error!`).
pub fn record_error() {
    ERROR_COUNT.fetch_add(1, Ordering::Relaxed);
}

/// Snapshot the cumulative heartbeat OK count.
pub fn heartbeat_ok_count() -> u64 {
    HEARTBEAT_OK_COUNT.load(Ordering::Relaxed)
}

/// Snapshot the cumulative error count.
pub fn error_count() -> u64 {
    ERROR_COUNT.load(Ordering::Relaxed)
}

/// Push a latency sample through the singleton. Falls back to creating
/// the singleton on first call.
pub fn record_latency(op: &'static str, elapsed: Duration) {
    let mut g = MONITOR.lock().expect("monitor mutex poisoned");
    g.get_or_insert_with(Monitor::new).record_latency(op, elapsed);
}

/// `(count, p95)` for an op over a window. `(0, Duration::ZERO)` when
/// no samples land in the window.
pub fn op_stats(op: &'static str, window: Duration) -> (usize, Duration) {
    let g = MONITOR.lock().expect("monitor mutex poisoned");
    match g.as_ref() {
        Some(m) => m.op_stats(op, window),
        None => (0, Duration::ZERO),
    }
}

/// Process uptime since `init()`. `Duration::ZERO` when init hasn't been
/// called yet.
pub fn uptime() -> Duration {
    let g = MONITOR.lock().expect("monitor mutex poisoned");
    match g.as_ref() {
        Some(m) => m.uptime(),
        None => Duration::ZERO,
    }
}

/// Compact health snapshot — the structure the future `monitoring_status`
/// Tauri command will return so the React dashboard can render uptime /
/// heartbeats / error rate without a second round-trip.
#[derive(Debug, Clone)]
pub struct HealthSnapshot {
    pub uptime_secs: u64,
    pub heartbeats_ok: u64,
    pub errors_total: u64,
}

/// Snapshot of the three top-line counters. Cheap — no allocation, no
/// IO. Safe to call from a Tauri command on the main thread.
pub fn health_snapshot() -> HealthSnapshot {
    HealthSnapshot {
        uptime_secs: uptime().as_secs(),
        heartbeats_ok: heartbeat_ok_count(),
        errors_total: error_count(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    /// Reset is best-effort — the singleton is process-global so concurrent
    /// tests share state. We only assert deltas inside a test, never
    /// absolute values.
    fn reset() {
        HEARTBEAT_OK_COUNT.store(0, Ordering::Relaxed);
        ERROR_COUNT.store(0, Ordering::Relaxed);
        let mut g = MONITOR.lock().unwrap();
        *g = Some(Monitor::new());
    }

    #[test]
    fn heartbeat_counter_bumps() {
        reset();
        let before = heartbeat_ok_count();
        record_heartbeat_ok();
        record_heartbeat_ok();
        let after = heartbeat_ok_count();
        assert!(after >= before + 2, "heartbeat counter must bump by ≥ 2");
    }

    #[test]
    fn error_counter_bumps() {
        reset();
        let before = error_count();
        record_error();
        let after = error_count();
        assert!(after >= before + 1);
    }

    #[test]
    fn latency_samples_p95() {
        reset();
        for ms in 1..=20u64 {
            record_latency("test_op", Duration::from_millis(ms));
        }
        let (count, p95) = op_stats("test_op", Duration::from_secs(60));
        assert_eq!(count, 20);
        // p95 of 1..=20 (length 20) → idx floor(20*0.95)=19 → samples[19] = 20 ms.
        assert_eq!(p95, Duration::from_millis(20));
    }

    #[test]
    fn op_stats_empty_returns_zero() {
        reset();
        let (count, p95) = op_stats("nonexistent", Duration::from_secs(60));
        assert_eq!(count, 0);
        assert_eq!(p95, Duration::ZERO);
    }

    #[test]
    fn health_snapshot_returns_consistent_struct() {
        reset();
        record_heartbeat_ok();
        record_error();
        let snap = health_snapshot();
        // Counters live process-wide so we only assert ≥, not equality.
        assert!(snap.heartbeats_ok >= 1);
        assert!(snap.errors_total >= 1);
    }
}
