"""v1.15.0 Wave 1.4 — event_router activation surface.

Covers:
  1. ``ACTIVATION_EVENT_NAMES`` is the stable contract the React shell
     keys off — a rename here would silently break the activation
     funnel, so we pin every name + count.
  2. ``is_real_atom`` mirrors the React-side R9 sample-isolation check.
  3. ``count_real_atoms`` excludes seeded fixtures from the funnel.

The actual ``first_real_atom_captured`` telemetry fire happens on the
React side (`FirstRealAtomActivation`); this file just covers the
Python helpers the dogfood CLI + future pipelines import.
"""

from __future__ import annotations

from tmi.event_router import (
    ACTIVATION_EVENT_NAMES,
    Event,
    EventRefs,
    count_real_atoms,
    is_real_atom,
)


def _make(*, sample: bool = False, body: str = "x") -> Event:
    """Tiny event factory — only the fields the activation helpers
    care about. The full schema lives in test_event_router.py."""
    return Event(
        id="evt-2026-04-28-abcdef0123",
        ts="2026-04-28T09:30:00+08:00",
        source="github",
        actor="me",
        actors=["me"],
        kind="comment",
        refs=EventRefs(),
        body=body,
        sample=sample,
    )


# ----------------------------------------------------------------------
# ACTIVATION_EVENT_NAMES contract


def test_activation_event_names_pinned() -> None:
    """A future rename of any of these silently breaks the React
    funnel. Pin the exact names + the count."""
    expected = {
        "onboarding_wizard_shown",
        "onboarding_path_chosen",
        "onboarding_detection_completed",
        "onboarding_mcp_configured",
        "onboarding_mcp_failed",
        "onboarding_skipped_to_demo",
        "onboarding_skipped_to_manual",
        "onboarding_completed",
        "mcp_connected",
        "first_real_atom_captured",
        "demo_tour_step_completed",
        "demo_to_real_conversion",
        "solo_cloud_upgrade_prompt_shown",
        "solo_cloud_upgrade_clicked",
    }
    assert set(ACTIVATION_EVENT_NAMES) == expected
    assert len(ACTIVATION_EVENT_NAMES) == 14


def test_activation_event_names_includes_first_real_atom_captured() -> None:
    """The activation marker is the gate event — a missing name here
    means the funnel is silently broken."""
    assert "first_real_atom_captured" in ACTIVATION_EVENT_NAMES


# ----------------------------------------------------------------------
# is_real_atom — R9 invariant mirror


def test_is_real_atom_true_for_non_sample() -> None:
    ev = _make(sample=False)
    assert is_real_atom(ev) is True


def test_is_real_atom_false_for_sample_seed() -> None:
    """R9 invariant: a Wave 13 demo seed (sample=True) must NEVER
    count toward activation. Same predicate as the React listener."""
    ev = _make(sample=True)
    assert is_real_atom(ev) is False


# ----------------------------------------------------------------------
# count_real_atoms — funnel counter


def test_count_real_atoms_excludes_samples() -> None:
    events = [
        _make(sample=False, body="real-1"),
        _make(sample=True, body="seed-1"),
        _make(sample=False, body="real-2"),
        _make(sample=True, body="seed-2"),
        _make(sample=False, body="real-3"),
    ]
    assert count_real_atoms(events) == 3


def test_count_real_atoms_empty_iterable() -> None:
    assert count_real_atoms([]) == 0


def test_count_real_atoms_all_samples() -> None:
    events = [_make(sample=True), _make(sample=True)]
    assert count_real_atoms(events) == 0


def test_count_real_atoms_handles_generator() -> None:
    """Helper accepts any Iterable, not just list. Important because
    the dogfood CLI streams events from rebuild_index lazily."""

    def gen() -> object:
        for i in range(5):
            yield _make(sample=(i % 2 == 0), body=f"e{i}")

    # 5 events: indices 0,2,4 are sample=True → 2 real atoms (1, 3).
    assert count_real_atoms(gen()) == 2  # type: ignore[arg-type]
