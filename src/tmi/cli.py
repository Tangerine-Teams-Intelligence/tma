"""tmi — Tangerine Meeting Assistant CLI.

Spec: INTERFACES.md §4.

9 commands: init, new, prep, start, observe, wrap, review, apply, list, status.
(That's 10 — list and status are both included per spec §4.9 / §4.10.)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from . import __version__
from .config import (
    DEFAULT_CONFIG_PATH,
    Config,
    load_config,
    render_default_template,
)
from .meeting import (
    create_meeting,
    infer_meeting_id,
    list_meetings,
    load_meeting,
    meeting_dir,
)
from .state import (
    load_status,
    save_status,
    transition,
    update_intent,
)
from .utils import atomic_write_text, meeting_lock, now_iso, setup_logging

console = Console()
err = Console(stderr=True)

app = typer.Typer(
    name="tmi",
    help="Tangerine Meeting Assistant. Your meeting -> your team's AI context.",
    rich_markup_mode="rich",
    add_completion=False,
    no_args_is_help=True,
)


# ----------------------------------------------------------------------
# Global option helpers


def _resolve_config(config_path: Optional[Path]) -> tuple[Config, Path]:
    p = (config_path or DEFAULT_CONFIG_PATH).expanduser()
    cfg = load_config(p)
    setup_logging(cfg.logging.level, cfg.logfile_path())
    return cfg, p


def _resolve_meeting_id(cfg: Config, mid: Optional[str]) -> str:
    if mid:
        return mid
    return infer_meeting_id(cfg)


# ----------------------------------------------------------------------
# 4.1 init


@app.command(help="Bootstrap ~/.tmi/config.yaml + meetings repo. Run once per machine.")
def init(
    meetings_repo: Optional[Path] = typer.Option(
        None, "--meetings-repo", help="Path to git repo for meetings/ (created if missing)."
    ),
    target_repo: Optional[Path] = typer.Option(
        None, "--target-repo", help="Default Claude Code target repo for the first adapter."
    ),
    force: bool = typer.Option(False, "--force", help="Overwrite existing ~/.tmi/config.yaml."),
    config: Optional[Path] = typer.Option(None, "--config", help="Override config path."),
) -> None:
    cfg_path = (config or DEFAULT_CONFIG_PATH).expanduser()
    if cfg_path.exists() and not force:
        err.print(f"[red]config already exists at {cfg_path}; --force to overwrite[/]")
        raise typer.Exit(2)

    if meetings_repo is None:
        meetings_repo = Path.home() / "tangerine-meetings"
    meetings_repo = meetings_repo.expanduser().resolve()
    meetings_repo.mkdir(parents=True, exist_ok=True)

    # git init if not a repo
    if not (meetings_repo / ".git").exists():
        try:
            subprocess.run(
                ["git", "init"], cwd=str(meetings_repo), check=True, capture_output=True
            )
            console.print(f"[green]git init[/] {meetings_repo}")
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            err.print(f"[red]git init failed: {e}[/]")
            raise typer.Exit(2)

    # Verify claude
    claude_bin = shutil.which("claude")
    if claude_bin is None:
        err.print("[yellow]warning: `claude` CLI not in PATH; set claude.cli_path manually[/]")
    else:
        try:
            r = subprocess.run([claude_bin, "--version"], capture_output=True, timeout=10)
            if r.returncode == 0:
                console.print(f"[green]claude OK[/] {r.stdout.decode().strip()}")
        except (subprocess.SubprocessError, OSError):
            err.print("[yellow]warning: `claude --version` failed[/]")

    # Verify node (only relevant when bot is built)
    if shutil.which("node") is None:
        err.print("[yellow]warning: `node` not in PATH (Discord bot needs it)[/]")

    target_repo = (target_repo or meetings_repo).expanduser().resolve()
    template = render_default_template(meetings_repo, target_repo)
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    from .utils import atomic_write_text

    atomic_write_text(cfg_path, template)
    console.print(f"[bold green]wrote[/] {cfg_path}")
    console.print("Edit team[] and output_adapters[] to taste, then `tmi new <title>`.")


# ----------------------------------------------------------------------
# 4.2 new


@app.command(help="Create a new meeting directory.")
def new(
    title: str = typer.Argument(..., help="Free-text title; date is today."),
    participants: Optional[str] = typer.Option(
        None, "--participants", help="Comma-separated aliases. Defaults to all team[]."
    ),
    scheduled: Optional[str] = typer.Option(
        None, "--scheduled", help="Optional RFC 3339 scheduled-at timestamp."
    ),
    target: Optional[str] = typer.Option(
        None, "--target", help="Output adapter name (defaults to sole adapter)."
    ),
    suffix: Optional[str] = typer.Option(
        None, "--suffix", help="Disambiguator slug if title collides today."
    ),
    config: Optional[Path] = typer.Option(None, "--config", help="Override config path."),
) -> None:
    cfg, _ = _resolve_config(config)
    plist = None
    if participants:
        plist = [p.strip() for p in participants.split(",") if p.strip()]
    sched = None
    if scheduled:
        try:
            sched = datetime.fromisoformat(scheduled)
        except ValueError as e:
            err.print(f"[red]invalid --scheduled: {e}[/]")
            raise typer.Exit(1)

    mdir = create_meeting(
        cfg,
        title,
        participants=plist,
        scheduled_at=sched,
        target=target,
        suffix=suffix,
    )
    # Plain print (not Rich) so callers can parse stdout cleanly.
    print(str(mdir.resolve()))


# ----------------------------------------------------------------------
# 4.3 prep


@app.command(help="Interactive intent prep for one participant. `done` to finalize.")
def prep(
    meeting_id: Optional[str] = typer.Argument(None),
    alias: Optional[str] = typer.Option(None, "--alias", help="Whose intent. Required if ambiguous."),
    turn_limit: int = typer.Option(20, "--turn-limit", help="Max prep turns."),
    force: bool = typer.Option(False, "--force", help="Overwrite a locked intent."),
    mock_claude: bool = typer.Option(
        False, "--mock-claude", help="Use built-in mock instead of real `claude` subprocess."
    ),
    config: Optional[Path] = typer.Option(None, "--config", help="Override config path."),
) -> None:
    cfg, _ = _resolve_config(config)
    mid = _resolve_meeting_id(cfg, meeting_id)
    mdir = meeting_dir(cfg, mid)
    m = load_meeting(mdir)

    if alias is None:
        # Pick first participant without a locked intent
        from .intent import is_locked

        for p in m.participants:
            if not is_locked(mdir, p.alias):
                alias = p.alias
                break
        if alias is None:
            err.print("[yellow]all intents locked; pass --alias <alias> --force to override[/]")
            raise typer.Exit(1)

    aliases = {p.alias for p in m.participants}
    if alias not in aliases:
        err.print(f"[red]alias {alias!r} not in meeting participants[/]")
        raise typer.Exit(1)

    from .intent import is_locked, write_intent

    if is_locked(mdir, alias) and not force:
        err.print(f"[red]intent for {alias!r} already locked; use --force[/]")
        raise typer.Exit(1)

    # Load ground truth via adapter
    try:
        from .adapters.claude_code import ClaudeCodeAdapter

        adapter_cfg = cfg.adapter_by_name(m.target_adapter)
        adapter = ClaudeCodeAdapter(
            target_repo=Path(adapter_cfg.target_repo),
            file_mappings={
                "claude_md": adapter_cfg.files.claude_md,
                "knowledge_dir": adapter_cfg.files.knowledge_dir,
                "session_state": adapter_cfg.files.session_state,
            },
            commit_author=adapter_cfg.commit_author,
        )
        gt = adapter.read_ground_truth()
        gt_envelope = {
            "claude_md": gt.claude_md,
            "session_state": gt.session_state,
            "knowledge_files": [{"path": kf.path, "content": kf.content} for kf in gt.knowledge_files],
        }
    except (ImportError, KeyError) as e:
        err.print(f"[yellow]ground truth unavailable ({e}); proceeding with empty[/]")
        gt_envelope = {"claude_md": "", "session_state": "", "knowledge_files": []}

    from .observer.prep import run_prep

    try:
        intent_md = run_prep(
            cfg,
            mdir,
            m,
            alias,
            ground_truth=gt_envelope,
            turn_limit=turn_limit,
            mock=mock_claude or os.environ.get("TMI_CLAUDE_MODE") == "stub",
        )
    except RuntimeError as e:
        err.print(f"[red]prep failed: {e}[/]")
        raise typer.Exit(3)

    # Validate + write
    try:
        fm = write_intent(mdir, alias, intent_md)
    except ValueError as e:
        err.print(f"[red]intent malformed: {e}[/]")
        raise typer.Exit(3)

    # Update status
    status = load_status(mdir)
    update_intent(status, alias, ready=True, locked_at=fm.locked_at)
    if status.state == "created":
        try:
            transition(status, "prepped")
        except ValueError:
            pass
    save_status(mdir, status)

    # Commit
    _git_commit(cfg.meetings_repo_path(), f"prep: {mid} {alias}", paths=[
        str(mdir / "intents" / f"{alias}.md"),
        str(mdir / "status.yaml"),
    ])

    console.print(f"[green]intent locked[/] for {alias} -> intents/{alias}.md")


# ----------------------------------------------------------------------
# 4.4 start


@app.command(help="Spawn Discord bot + observer for a live meeting.")
def start(
    meeting_id: Optional[str] = typer.Argument(None),
    no_bot: bool = typer.Option(False, "--no-bot"),
    no_observer: bool = typer.Option(False, "--no-observer"),
    strict: bool = typer.Option(False, "--strict", help="Refuse start if no intents locked."),
    mock_claude: bool = typer.Option(False, "--mock-claude"),
    config: Optional[Path] = typer.Option(None, "--config"),
) -> None:
    cfg, cfg_path = _resolve_config(config)
    mid = _resolve_meeting_id(cfg, meeting_id)
    mdir = meeting_dir(cfg, mid)
    load_meeting(mdir)
    status = load_status(mdir)

    if status.state not in {"created", "prepped"}:
        err.print(f"[red]cannot start meeting in state {status.state}[/]")
        raise typer.Exit(1)

    if status.state == "created":
        if strict:
            err.print("[red]no intents locked; --strict refuses[/]")
            raise typer.Exit(1)
        err.print("[yellow]warning: no intents locked, observer wrap quality will degrade[/]")

    with meeting_lock(mdir):
        # Spawn bot
        bot_pid = None
        if not no_bot:
            try:
                from .bot_launcher import spawn_bot

                proc = spawn_bot(cfg, cfg_path, mid, mdir)
                if proc is not None:
                    bot_pid = proc.pid
            except FileNotFoundError as e:
                err.print(f"[red]bot start failed: {e}[/]")
                raise typer.Exit(3)

        # Spawn observer (detached background)
        observer_pid = None
        if not no_observer:
            observer_pid = _spawn_detached_observer(cfg_path, mid, mdir, mock_claude=mock_claude)

        # Status updates
        status.bot.pid = bot_pid
        status.bot.started_at = datetime.fromisoformat(now_iso()) if bot_pid else None
        status.observer.pid = observer_pid
        status.observer.mode = "observe" if observer_pid else None
        transition(status, "live")
        save_status(mdir, status)

    # Banner
    table = Table(show_header=False, box=None)
    table.add_row("[bold]Status[/]", f"live · meeting={mid}")
    table.add_row("[bold]Tail[/]", f"tail -f \"{mdir / 'transcript.md'}\"")
    table.add_row("[bold]Flags[/]", f"tail -f \"{mdir / 'observations.md'}\"")
    table.add_row("[bold]Stop[/]", f"tmi wrap {mid}")
    console.print(table)


def _spawn_detached_observer(
    cfg_path: Path, meeting_id: str, mdir: Path, *, mock_claude: bool
) -> Optional[int]:
    """Spawn `python -m tmi.observer.run_observe_daemon` detached.

    Returns PID. Returns None if launch fails.
    """
    cmd = [
        sys.executable,
        "-m",
        "tmi.observer_daemon",
        "--meeting-id",
        meeting_id,
        "--config",
        str(cfg_path),
    ]
    if mock_claude or os.environ.get("TMI_CLAUDE_MODE") == "stub":
        cmd.append("--mock-claude")

    log_path = mdir / ".tmi" / "observer-daemon.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_fp = open(log_path, "ab")

    creationflags = 0
    if sys.platform == "win32":
        creationflags = 0x00000008 | 0x08000000

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=log_fp,
            stderr=log_fp,
            env=os.environ.copy(),
            creationflags=creationflags,
            close_fds=(sys.platform != "win32"),
        )
        return proc.pid
    except OSError as e:
        err.print(f"[yellow]observer daemon spawn failed: {e}[/]")
        return None


# ----------------------------------------------------------------------
# 4.5 observe


@app.command(help="Same as `start --no-bot`: observer only.")
def observe(
    meeting_id: Optional[str] = typer.Argument(None),
    mode: str = typer.Option("silent", "--mode", help="silent|active (active reserved for v1.1)."),
    mock_claude: bool = typer.Option(False, "--mock-claude"),
    config: Optional[Path] = typer.Option(None, "--config"),
) -> None:
    if mode == "active":
        err.print("[yellow]active mode not implemented, using silent[/]")
    cfg, cfg_path = _resolve_config(config)
    mid = _resolve_meeting_id(cfg, meeting_id)
    mdir = meeting_dir(cfg, mid)
    status = load_status(mdir)

    if status.state not in {"created", "prepped"}:
        err.print(f"[red]cannot observe in state {status.state}[/]")
        raise typer.Exit(1)

    with meeting_lock(mdir):
        observer_pid = _spawn_detached_observer(cfg_path, mid, mdir, mock_claude=mock_claude)
        status.observer.pid = observer_pid
        status.observer.mode = "observe" if observer_pid else None
        transition(status, "live")
        save_status(mdir, status)

    console.print(f"[green]observer-only mode[/] meeting={mid} pid={observer_pid}")


# ----------------------------------------------------------------------
# 4.6 wrap


@app.command(help="End the meeting; produce summary.md + knowledge-diff.md.")
def wrap(
    meeting_id: Optional[str] = typer.Argument(None),
    auto: bool = typer.Option(False, "--auto", help="Internal: invoked by /tmi-leave from bot."),
    no_stop: bool = typer.Option(False, "--no-stop", help="Don't kill bot/observer."),
    mock_claude: bool = typer.Option(False, "--mock-claude"),
    config: Optional[Path] = typer.Option(None, "--config"),
) -> None:
    cfg, _ = _resolve_config(config)
    mid = _resolve_meeting_id(cfg, meeting_id)
    mdir = meeting_dir(cfg, mid)
    m = load_meeting(mdir)
    status = load_status(mdir)

    if status.state not in {"live", "ended"}:
        err.print(f"[red]cannot wrap in state {status.state}[/]")
        raise typer.Exit(1)

    if status.state == "live" and not no_stop:
        # Signal bot + observer to stop
        from .utils import pid_alive

        for pid in (status.bot.pid, status.observer.pid):
            if pid and pid_alive(pid):
                _kill_pid(pid)
        status.bot.pid = None
        status.observer.pid = None
        status.observer.mode = None
        transition(status, "ended")
        save_status(mdir, status)

    # Build envelope
    from .adapters.claude_code import ClaudeCodeAdapter
    from .intent import read_intent
    from .observer.wrap import WrapError, run_wrap
    from .transcript import read_all as read_transcript_all

    adapter_cfg = cfg.adapter_by_name(m.target_adapter)
    try:
        adapter = ClaudeCodeAdapter(
            target_repo=Path(adapter_cfg.target_repo),
            file_mappings={
                "claude_md": adapter_cfg.files.claude_md,
                "knowledge_dir": adapter_cfg.files.knowledge_dir,
                "session_state": adapter_cfg.files.session_state,
            },
            commit_author=adapter_cfg.commit_author,
        )
        gt = adapter.read_ground_truth()
        gt_envelope = {
            "claude_md": gt.claude_md,
            "session_state": gt.session_state,
            "knowledge_files": [{"path": kf.path, "content": kf.content} for kf in gt.knowledge_files],
        }
    except (ImportError, KeyError) as e:
        err.print(f"[yellow]ground truth unavailable ({e}); proceeding with empty[/]")
        gt_envelope = {"claude_md": "", "session_state": "", "knowledge_files": []}

    intents = []
    for p in m.participants:
        try:
            fm, body = read_intent(mdir, p.alias)
            full = (mdir / "intents" / f"{p.alias}.md").read_text(encoding="utf-8")
            intents.append({"alias": p.alias, "markdown": full})
        except (FileNotFoundError, ValueError):
            continue

    obs_path = mdir / "observations.md"
    observations = obs_path.read_text(encoding="utf-8") if obs_path.exists() else ""

    envelope = {
        "mode": "wrap",
        "meeting": m.model_dump(mode="json"),
        "intents": intents,
        "transcript": read_transcript_all(mdir),
        "observations": observations,
        "ground_truth": gt_envelope,
        "adapter_conventions": {
            "claude_md_sections": [],
            "session_state_format": "## YYYY-MM-DD — <title> blocks",
            "knowledge_dir_pattern": f"{adapter_cfg.files.knowledge_dir}<topic>.md",
        },
    }

    try:
        result = run_wrap(
            cfg,
            mdir,
            envelope,
            retries=1,
            mock=mock_claude or os.environ.get("TMI_CLAUDE_MODE") == "stub",
        )
    except WrapError as e:
        err.print(f"[red]wrap failed: {e}[/]")
        try:
            transition(status, "failed_wrap")
            save_status(mdir, status)
        except ValueError:
            pass
        raise typer.Exit(3)

    # Atomic write of both — write tmp first, rename both, never leave half state
    from .utils import atomic_write_text

    summary_path = mdir / "summary.md"
    diff_path = mdir / "knowledge-diff.md"
    atomic_write_text(summary_path, result.summary_markdown)
    atomic_write_text(diff_path, result.diff_markdown)

    # Count blocks for status
    try:
        diff = adapter.parse_diff(result.diff_markdown)
        block_count = len(diff.blocks)
    except (ValueError, NotImplementedError):
        block_count = None

    # Memory layer: write the unified meeting file + any extracted decisions
    # under <target_repo>/memory/. Best-effort — failures here log but do not
    # break wrap.
    memory_paths: list[Path] = []
    transcript_text_for_extract: str = ""
    memory_root_for_router: Path | None = None
    try:
        from .memory import write_decisions, write_meeting_file
        from .transcript import read_all as read_transcript_all_for_memory

        memory_root = cfg.memory_root_path(m.target_adapter)
        memory_root_for_router = memory_root
        transcript_text = read_transcript_all_for_memory(mdir)
        transcript_text_for_extract = transcript_text

        # Strip frontmatter from the summary for the embedded body
        summary_body = result.summary_markdown
        if summary_body.startswith("---\n"):
            end = summary_body.find("\n---\n", 4)
            if end != -1:
                summary_body = summary_body[end + 5 :].lstrip("\n")

        decision_writes = write_decisions(memory_root, m, result.summary_markdown)
        decision_links = [(slug.replace("-", " "), slug) for slug, _ in decision_writes]
        meeting_path = write_meeting_file(
            memory_root,
            m,
            transcript_text,
            summary_body=summary_body,
            decision_links=decision_links or None,
        )
        memory_paths.append(meeting_path)
        memory_paths.extend(p for _, p in decision_writes)
        console.print(
            f"[green]memory[/] meeting={meeting_path.name} "
            f"decisions={len(decision_writes)} root={memory_root}"
        )
    except (OSError, ValueError) as e:
        err.print(f"[yellow]memory write skipped: {e}[/]")

    # v1.7: Event Router fan-out. Take every memory file we just wrote and
    # extract atomic events into the timeline. Best-effort — never break wrap.
    if memory_root_for_router is not None and memory_paths:
        try:
            from .event_router import process as route_process
            from .event_router import write_sidecar_docs

            # Materialise sidecar docs (idempotent).
            write_sidecar_docs(memory_root_for_router)
            total_events = 0
            for mp in memory_paths:
                rr = route_process(memory_root_for_router, mp)
                total_events += len(rr.events)
            if total_events:
                console.print(
                    f"[green]timeline[/] routed {total_events} event(s) from "
                    f"{len(memory_paths)} file(s)"
                )
        except Exception as e:  # noqa: BLE001 — wrap survives router failures
            err.print(f"[yellow]event_router skipped: {e}[/]")

    # v1.6: AI extractor — populate people/projects/threads/glossary. Best-
    # effort. Skipped if `claude` not in PATH or if extractor errors out.
    try:
        if transcript_text_for_extract.strip():
            counts = _run_extractor(
                cfg, m, mdir, transcript_text_for_extract, mock=mock_claude
            )
            if counts is not None:
                console.print(
                    f"[green]extracted[/] "
                    f"{counts['people']} people, "
                    f"{counts['projects']} projects, "
                    f"{counts['threads']} threads, "
                    f"{counts['glossary']} glossary"
                )
    except Exception as e:  # noqa: BLE001 — never break wrap
        err.print(f"[yellow]extractor skipped: {e}[/]")

    status = load_status(mdir)
    status.wrap.completed_at = datetime.fromisoformat(now_iso())
    status.wrap.diff_block_count = block_count
    transition(status, "wrapped")
    save_status(mdir, status)

    _git_commit(
        cfg.meetings_repo_path(),
        f"wrap: {mid}",
        paths=[str(summary_path), str(diff_path), str(mdir / "status.yaml")],
    )

    console.print(f"[green]wrapped[/] summary={summary_path.name} diff_blocks={block_count}")


def _kill_pid(pid: int) -> None:
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
        else:
            os.kill(pid, 15)
    except (OSError, subprocess.SubprocessError):
        pass


# ----------------------------------------------------------------------
# 4.7 review


@app.command(help="Interactive review of knowledge-diff.md blocks.")
def review(
    meeting_id: Optional[str] = typer.Argument(None),
    auto_approve_all: bool = typer.Option(
        False, "--auto-approve-all", help="Test hook (spec §12.5 step 7)."
    ),
    json_out: bool = typer.Option(
        False,
        "--json",
        help="Emit blocks as JSON to stdout (skip TUI). For app/agent consumers.",
    ),
    apply_decisions: Optional[Path] = typer.Option(
        None,
        "--apply-decisions",
        help="With --json: read decisions from this JSON file and persist them. "
        "Shape: {approved: [int], rejected: [int], edited: {id: 'body'}}.",
    ),
    config: Optional[Path] = typer.Option(None, "--config"),
) -> None:
    cfg, _ = _resolve_config(config)
    mid = _resolve_meeting_id(cfg, meeting_id)
    mdir = meeting_dir(cfg, mid)
    m = load_meeting(mdir)
    status = load_status(mdir)

    if status.state != "wrapped":
        err.print(f"[red]review requires state=wrapped, got {status.state}[/]")
        raise typer.Exit(1)

    diff_path = mdir / "knowledge-diff.md"
    if not diff_path.exists():
        err.print(f"[red]knowledge-diff.md missing at {diff_path}[/]")
        raise typer.Exit(1)

    from .adapters.claude_code import ClaudeCodeAdapter
    from .review import apply_decisions_dict, review_loop

    adapter_cfg = cfg.adapter_by_name(m.target_adapter)
    adapter = ClaudeCodeAdapter(
        target_repo=Path(adapter_cfg.target_repo),
        file_mappings={
            "claude_md": adapter_cfg.files.claude_md,
            "knowledge_dir": adapter_cfg.files.knowledge_dir,
            "session_state": adapter_cfg.files.session_state,
        },
        commit_author=adapter_cfg.commit_author,
    )
    try:
        diff = adapter.parse_diff(diff_path.read_text(encoding="utf-8"))
    except ValueError as e:
        err.print(f"[red]knowledge-diff.md parse failed: {e}[/]")
        raise typer.Exit(1)

    # JSON branch: machine-readable. Used by the desktop app (RV-0).
    if json_out:
        if apply_decisions is not None:
            try:
                with open(apply_decisions, encoding="utf-8") as fp:
                    decisions = json.load(fp)
            except (OSError, json.JSONDecodeError) as e:
                err.print(f"[red]could not read --apply-decisions file: {e}[/]")
                raise typer.Exit(1)
            outcome = apply_decisions_dict(mdir, diff.blocks, decisions)
            # Write any edits back into knowledge-diff.md (same logic as
            # interactive path below).
            if outcome.edited:
                new_blocks = []
                for b in diff.blocks:
                    if b.id in outcome.edited:
                        b = b.model_copy(update={"body": outcome.edited[b.id]})
                    new_blocks.append(b)
                from .adapters.diff_parser import serialize_diff

                new_text = serialize_diff(diff.model_copy(update={"blocks": new_blocks}))
                atomic_write_text(diff_path, new_text)
            # Reload status; promote to reviewed if all decided.
            status = load_status(mdir)
            decided = set(outcome.approved) | set(outcome.rejected)
            all_ids = {b.id for b in diff.blocks}
            if decided >= all_ids:
                try:
                    transition(status, "reviewed")
                    save_status(mdir, status)
                except ValueError:
                    pass

        # Emit JSON snapshot
        status = load_status(mdir)
        approved = set(status.review.approved_block_ids)
        rejected = set(status.review.rejected_block_ids)
        edited = set(status.review.edited_block_ids)

        def _block_status(bid: int) -> str:
            if bid in edited:
                return "edited"
            if bid in approved:
                return "approved"
            if bid in rejected:
                return "rejected"
            return "pending"

        payload = {
            "meeting_id": mid,
            "state": status.state,
            "blocks": [
                {
                    "id": b.id,
                    "target_file": b.target_file,
                    "action": b.action,
                    "insert_anchor": b.insert_anchor,
                    "reason": b.reason,
                    "transcript_refs": b.transcript_refs,
                    "body": b.body,
                    "status": _block_status(b.id),
                }
                for b in diff.blocks
            ],
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        sys.stdout.flush()
        raise typer.Exit(0)

    outcome = review_loop(mdir, diff.blocks, auto_approve_all=auto_approve_all)

    # Reload status — review_loop persisted approvals/rejections via its own load+save.
    # Without reloading, the local `status` is stale and the upcoming save_status would
    # overwrite review.approved_block_ids back to empty.
    status = load_status(mdir)

    # If every block decided, transition wrapped -> reviewed
    decided = set(outcome.approved) | set(outcome.rejected)
    all_ids = {b.id for b in diff.blocks}
    if decided >= all_ids:
        try:
            transition(status, "reviewed")
            save_status(mdir, status)
            console.print("[green]all blocks decided -> state=reviewed[/]")
        except ValueError:
            pass
    else:
        remaining = all_ids - decided
        console.print(f"[yellow]{len(remaining)} block(s) skipped; rerun review to finish[/]")

    # If any blocks were edited, rewrite knowledge-diff.md with edited bodies
    if outcome.edited:
        new_blocks = []
        for b in diff.blocks:
            if b.id in outcome.edited:
                b = b.model_copy(update={"body": outcome.edited[b.id]})
            new_blocks.append(b)
        from .adapters.diff_parser import serialize_diff

        new_text = serialize_diff(diff.model_copy(update={"blocks": new_blocks}))
        atomic_write_text(diff_path, new_text)
        console.print(f"[green]rewrote knowledge-diff.md with {len(outcome.edited)} edit(s)[/]")


# ----------------------------------------------------------------------
# 4.8 apply


@app.command(help="Apply approved blocks to target repo + commit.")
def apply(
    meeting_id: Optional[str] = typer.Argument(None),
    no_commit: bool = typer.Option(False, "--no-commit"),
    force: bool = typer.Option(False, "--force", help="Override 'uncommitted changes' guard."),
    retry: bool = typer.Option(False, "--retry", help="Retry from failed_apply."),
    config: Optional[Path] = typer.Option(None, "--config"),
) -> None:
    cfg, _ = _resolve_config(config)
    mid = _resolve_meeting_id(cfg, meeting_id)
    mdir = meeting_dir(cfg, mid)
    m = load_meeting(mdir)
    status = load_status(mdir)

    if status.state == "failed_apply" and retry:
        # Allow retry
        status.state = "reviewed"
    if status.state != "reviewed":
        err.print(f"[red]apply requires state=reviewed, got {status.state}[/]")
        raise typer.Exit(1)

    if not status.review.approved_block_ids:
        err.print("[yellow]no approved blocks; nothing to apply[/]")
        raise typer.Exit(0)

    from .adapters.claude_code import ClaudeCodeAdapter

    adapter_cfg = cfg.adapter_by_name(m.target_adapter)
    adapter = ClaudeCodeAdapter(
        target_repo=Path(adapter_cfg.target_repo),
        file_mappings={
            "claude_md": adapter_cfg.files.claude_md,
            "knowledge_dir": adapter_cfg.files.knowledge_dir,
            "session_state": adapter_cfg.files.session_state,
        },
        commit_author=adapter_cfg.commit_author,
    )

    diff = adapter.parse_diff((mdir / "knowledge-diff.md").read_text(encoding="utf-8"))

    try:
        result = adapter.apply_diff(
            diff,
            approved_block_ids=status.review.approved_block_ids,
            commit=(not no_commit),
        )
    except Exception as e:
        err.print(f"[red]apply failed: {e}[/]")
        try:
            transition(status, "failed_apply")
            save_status(mdir, status)
        except ValueError:
            pass
        raise typer.Exit(4)

    if result.skipped_block_ids and not result.written_files:
        err.print("[red]apply skipped all blocks (likely uncommitted changes in target_repo)[/]")
        for msg in result.messages:
            err.print(f"  {msg}")
        try:
            transition(status, "failed_apply")
            save_status(mdir, status)
        except ValueError:
            pass
        raise typer.Exit(4)

    status.apply.target_repo = adapter_cfg.target_repo
    status.apply.commit_sha = result.commit_sha
    status.apply.applied_at = datetime.fromisoformat(now_iso())
    transition(status, "merged")
    save_status(mdir, status)

    console.print(f"[green]applied[/] {len(result.written_files)} file(s) commit={result.commit_sha}")
    if not no_commit:
        console.print(f"Reminder: cd \"{adapter_cfg.target_repo}\" && git push")


# ----------------------------------------------------------------------
# 4.9 list


@app.command(name="list", help="List meetings.")
def list_cmd(
    status: Optional[str] = typer.Option(None, "--status", help="Filter by state."),
    since: Optional[str] = typer.Option(None, "--since", help="Filter by ISO date prefix."),
    config: Optional[Path] = typer.Option(None, "--config"),
) -> None:
    cfg, _ = _resolve_config(config)
    rows = list_meetings(cfg)
    if status:
        rows = [r for r in rows if r[1] == status]
    if since:
        rows = [r for r in rows if r[0] >= since]
    for mid, st, title in rows:
        console.print(f"{mid}  {st}  {title}")


# ----------------------------------------------------------------------
# 4.10 status


@app.command(help="Print human-readable status for a meeting.")
def status(
    meeting_id: Optional[str] = typer.Argument(None),
    config: Optional[Path] = typer.Option(None, "--config"),
) -> None:
    cfg, _ = _resolve_config(config)
    mid = _resolve_meeting_id(cfg, meeting_id)
    mdir = meeting_dir(cfg, mid)
    m = load_meeting(mdir)
    st = load_status(mdir)
    from .transcript import line_count

    table = Table(title=f"{mid} — {m.title}", show_header=False)
    table.add_row("State", st.state)
    table.add_row("Updated", st.state_updated_at)
    table.add_row("Participants", ", ".join(p.alias for p in m.participants))
    locked = sum(1 for v in st.intents.values() if v.ready)
    table.add_row("Intents", f"{locked}/{len(m.participants)} locked")
    table.add_row("Transcript lines", str(line_count(mdir)))
    table.add_row("Bot pid", str(st.bot.pid))
    table.add_row("Observer pid", str(st.observer.pid))
    table.add_row("Errors", str(len(st.errors)))
    console.print(table)


# ----------------------------------------------------------------------
# v1.6: extract entities (people/projects/threads/glossary)


def _resolve_claude_cli(cfg: Config) -> Path | None:
    """Return absolute path to claude binary, or None if not found."""
    cli_path = cfg.claude.cli_path
    if cli_path:
        p = Path(cli_path).expanduser()
        if p.exists():
            return p
    found = shutil.which("claude")
    return Path(found) if found else None


def _run_extractor(
    cfg: Config,
    meeting,  # type: ignore[no-untyped-def] # tmi.meeting.Meeting; avoids circular import at module load
    meeting_dir_: Path,
    transcript_text: str,
    *,
    mock: bool = False,
) -> dict[str, int] | None:
    """Invoke the AI extractor and persist all four entity types.

    Returns a dict of per-bucket counts on success, or None if skipped (e.g.
    no `claude` binary available, or empty transcript).
    """
    from .extractor import extract_from_meeting
    from .memory import write_extracted_entities

    if mock or os.environ.get("TMI_CLAUDE_MODE") == "stub":
        # In mock/stub mode, run an offline fallback so the e2e test path is
        # still exercised. We synthesize a tiny entity set from speaker prefixes
        # in the transcript so downstream writers have something real to write.
        entities = _mock_extract(transcript_text)
    else:
        cli = _resolve_claude_cli(cfg)
        if cli is None:
            err.print("[yellow]extractor: claude CLI not found in PATH; skipping[/]")
            return None
        entities = extract_from_meeting(meeting_dir_, transcript_text, cli)

    if entities.is_empty():
        return entities.counts()

    memory_root = cfg.memory_root_path(meeting.target_adapter)
    write_extracted_entities(memory_root, entities, meeting)
    return entities.counts()


def _mock_extract(transcript_text: str):  # type: ignore[no-untyped-def]
    """Offline-only stub used when ``--mock-claude`` is set or
    ``TMI_CLAUDE_MODE=stub``. Produces one PersonMention per unique speaker
    prefix found in the transcript so wrap's e2e mock path writes real files
    without shelling out to a fake binary.
    """
    import re as _re

    from .extractor import ExtractedEntities, PersonMention

    speakers: dict[str, int] = {}
    for i, line in enumerate(transcript_text.splitlines(), start=1):
        m = _re.match(r"^\[\d{2}:\d{2}:\d{2}\]\s+([a-z][a-z0-9_]*)\s*:", line)
        if m:
            alias = m.group(1)
            speakers.setdefault(alias, i)
    people = [
        PersonMention(alias=a, context="Spoke in this meeting (mock).", transcript_lines=(ln,))
        for a, ln in speakers.items()
    ]
    return ExtractedEntities(people=people)


@app.command(help="Re-run the AI extractor on an existing meeting.")
def extract(
    meeting_id: Optional[str] = typer.Argument(None),
    mock_claude: bool = typer.Option(False, "--mock-claude"),
    config: Optional[Path] = typer.Option(None, "--config"),
) -> None:
    cfg, _ = _resolve_config(config)
    mid = _resolve_meeting_id(cfg, meeting_id)
    mdir = meeting_dir(cfg, mid)
    m = load_meeting(mdir)

    from .transcript import read_all as read_transcript_all_for_extract

    transcript_text = read_transcript_all_for_extract(mdir)
    if not transcript_text.strip():
        err.print(f"[yellow]extract: transcript empty for {mid}; nothing to do[/]")
        raise typer.Exit(0)

    counts = _run_extractor(cfg, m, mdir, transcript_text, mock=mock_claude)
    if counts is None:
        raise typer.Exit(2)
    console.print(
        f"[green]extracted[/] "
        f"{counts['people']} people, "
        f"{counts['projects']} projects, "
        f"{counts['threads']} threads, "
        f"{counts['glossary']} glossary"
    )


# ----------------------------------------------------------------------
# version

@app.callback(invoke_without_command=True)
def _root(
    ctx: typer.Context,
    version: bool = typer.Option(False, "--version", help="Show version and exit."),
) -> None:
    if version:
        console.print(f"tmi {__version__}")
        raise typer.Exit(0)
    if ctx.invoked_subcommand is None:
        console.print(ctx.get_help())
        raise typer.Exit(0)


# ----------------------------------------------------------------------
# git helper


def _git_commit(repo: Path, msg: str, paths: list[str]) -> None:
    """Best-effort commit. Skips silently if git unavailable or no changes."""
    if not (repo / ".git").exists():
        return
    try:
        subprocess.run(["git", "add", "--", *paths], cwd=str(repo), check=True, capture_output=True)
        r = subprocess.run(
            ["git", "diff", "--cached", "--quiet"], cwd=str(repo), capture_output=True
        )
        if r.returncode == 0:
            return  # nothing staged
        subprocess.run(
            ["git", "commit", "-m", msg], cwd=str(repo), check=True, capture_output=True
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        err.print(f"[yellow]git commit skipped: {e}[/]")


if __name__ == "__main__":
    app()
