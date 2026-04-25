"""End-to-end smoke test for Tangerine Meeting Assistant.

Validates the full happy path with mocks (no real Discord, no real Whisper, no real
`claude` CLI). Should run in <30 seconds. CI-runnable.

Strategy:
  init → new → prep (per member, mock-claude with empty stdin) → manually transition
  to live + write synthetic transcript → wrap → review --auto-approve-all → apply.
  Assert target repo updated + git commit landed.

We bypass `tmi start` because it spawns Discord bot + observer daemons; instead we
pre-populate transcript.md and step the state machine to `ended` so wrap will run.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent


def _run(*args, cwd=None, input=None, check=True, env=None):
    """Run a subprocess, surface stdout/stderr on failure."""
    cmd = [str(a) for a in args]
    print(f"\n>>> {' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        input=input,
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    if check and result.returncode != 0:
        raise RuntimeError(
            f"command failed (exit {result.returncode}): {' '.join(cmd)}\n"
            f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
        )
    return result


def _git(*args, cwd):
    return _run("git", *args, cwd=cwd)


@pytest.fixture
def env(tmp_path):
    """Build an isolated TMA env: temp config, temp meetings repo, temp target repo."""
    home = tmp_path / "home"
    home.mkdir()

    config_path = home / ".tmi" / "config.yaml"
    config_path.parent.mkdir()

    meetings_repo = tmp_path / "meetings"
    target_repo = tmp_path / "target_repo"
    target_repo.mkdir()

    # Skeletal target Claude Code repo
    (target_repo / "CLAUDE.md").write_text(
        "# Test Target Repo\n\nGround truth file used by smoke E2E.\n",
        encoding="utf-8",
    )
    knowledge = target_repo / "knowledge"
    knowledge.mkdir()
    (knowledge / "session-state.md").write_text(
        "# Session State\n\n## 最近会议\n\n(empty)\n",
        encoding="utf-8",
    )

    _git("init", cwd=target_repo)
    _git("config", "user.email", "smoke@test.local", cwd=target_repo)
    _git("config", "user.name", "Smoke Test", cwd=target_repo)
    _git("add", ".", cwd=target_repo)
    _git("commit", "-m", "initial", cwd=target_repo)

    # tmi init
    _run(
        "tmi",
        "init",
        "--config",
        config_path,
        "--meetings-repo",
        meetings_repo,
        "--target-repo",
        target_repo,
        "--force",
    )
    assert config_path.exists(), "tmi init did not create config"

    return {
        "home": home,
        "config": config_path,
        "meetings": meetings_repo,
        "target": target_repo,
    }


def _force_state(meeting_dir: Path, new_state: str) -> None:
    """Step status.yaml directly. Skips state-machine guards intentionally."""
    status_path = meeting_dir / "status.yaml"
    data = yaml.safe_load(status_path.read_text(encoding="utf-8"))
    data["state"] = new_state
    status_path.write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")


def _write_synthetic_transcript(meeting_dir: Path) -> None:
    """Pre-populate a transcript so wrap has something to synthesize."""
    transcript = (
        "[19:02:14] daizhe: 今天 sync 三件事——v1 input 平台、dual-stream 可行性、legal RFP 时间线。\n"
        "[19:02:24] hongyu: 收到。先 v1 平台。我倾向 Discord + Zoom 都做，不想锁死单一渠道。\n"
        "[19:02:48] daizhe: 双输入会让 v1 scope 拖到 6 周。Discord-only 4 周能 ship。\n"
        "[19:03:11] hongyu: 嗯…如果 4 周能 ship，我接受 Discord-only，Zoom 延 v1.1。\n"
        "[19:03:42] daizhe: 好。第二件——dual-stream feasibility。Hongyu 你测过 WASAPI loopback 没？\n"
        "[19:03:58] hongyu: 测过。能跑，但所有 voice 都被打成一个 user。per-user 流要 Discord bot 做。\n"
        "[19:04:21] daizhe: OK 那 v1 直接 Discord bot per-user，不走 WASAPI。Legal RFP 时间线 Advisor 不在，下次再说。\n"
        "[19:04:39] advisor: 我在了，刚加进来——我们下次同步 RFP，4/26 我准备好。\n"
        "[19:04:50] daizhe: 收到。今天 wrap。\n"
    )
    (meeting_dir / "transcript.md").write_text(transcript, encoding="utf-8")


def test_e2e_happy_path(env):
    """Complete meeting lifecycle: init → new → prep → wrap → review → apply."""
    config = env["config"]
    meetings = env["meetings"]
    target = env["target"]

    # 1. tmi new — create the meeting directory
    result = _run("tmi", "new", "Smoke Test Meeting", "--config", config)
    # The CLI prints the meeting dir path; parse from stdout
    meeting_dir = None
    for line in result.stdout.splitlines() + result.stderr.splitlines():
        line = line.strip()
        if line and "smoke-test-meeting" in line.lower() and Path(line).exists():
            meeting_dir = Path(line)
            break

    if meeting_dir is None:
        # Fallback: glob meetings/
        candidates = sorted((meetings / "meetings").glob("*smoke-test-meeting*")) or sorted(
            meetings.glob("**/*smoke-test-meeting*")
        )
        assert candidates, f"no meeting dir found under {meetings}"
        meeting_dir = candidates[-1]

    print(f"meeting_dir = {meeting_dir}")
    assert (meeting_dir / "meeting.yaml").exists()

    meeting_id = meeting_dir.name

    # 2. tmi prep — for each team member with mock-claude (empty stdin → canned intent)
    meeting_meta = yaml.safe_load((meeting_dir / "meeting.yaml").read_text(encoding="utf-8"))
    aliases = [p.get("alias") for p in meeting_meta.get("participants", []) if p.get("alias")]
    assert aliases, "meeting.yaml has no participants"

    for alias in aliases:
        _run(
            "tmi",
            "prep",
            meeting_id,
            "--alias",
            alias,
            "--mock-claude",
            "--config",
            config,
            input="",  # empty stdin → mock claude emits canned intent then exits
        )
        intent_path = meeting_dir / "intents" / f"{alias}.md"
        assert intent_path.exists(), f"intent for {alias} not written"

    # 3. Skip `tmi start` (spawns daemons). Step state to `ended` and write transcript.
    _write_synthetic_transcript(meeting_dir)
    _force_state(meeting_dir, "ended")

    # 4. tmi wrap with mock-claude — produces summary + diff
    _run(
        "tmi",
        "wrap",
        meeting_id,
        "--mock-claude",
        "--no-stop",
        "--config",
        config,
    )
    assert (meeting_dir / "summary.md").exists()
    assert (meeting_dir / "knowledge-diff.md").exists()

    # 5. tmi review --auto-approve-all
    _run(
        "tmi",
        "review",
        meeting_id,
        "--auto-approve-all",
        "--config",
        config,
    )
    status = yaml.safe_load((meeting_dir / "status.yaml").read_text(encoding="utf-8"))
    assert status["state"] in ("reviewed", "merged"), f"unexpected state: {status['state']}"

    # 6. tmi apply — write to target repo + git commit
    if status["state"] == "reviewed":
        _run("tmi", "apply", meeting_id, "--config", config)

    # 7. Assertions on target repo
    log = _git("log", "--oneline", "-5", cwd=target).stdout
    assert "meeting:" in log.lower() or "smoke" in log.lower(), f"no meeting commit in log:\n{log}"

    # The mock observer's wrap output appends a synthetic block to session-state.md
    final_state = (target / "knowledge" / "session-state.md").read_text(encoding="utf-8")
    assert len(final_state) > len("# Session State\n\n## 最近会议\n\n(empty)\n"), (
        "session-state.md was not augmented by tmi apply"
    )

    # Final status
    final_status = yaml.safe_load((meeting_dir / "status.yaml").read_text(encoding="utf-8"))
    assert final_status["state"] in ("merged", "reviewed"), final_status["state"]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v", "-s"]))
