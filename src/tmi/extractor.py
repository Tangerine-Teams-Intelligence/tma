"""AI auto-tag / classify pipeline for the memory layer.

Spec: V1_6_FEATURES.md (v1.6.0). Runs ONE Claude CLI call per meeting after
``tmi wrap`` finishes the existing meeting + decision extraction. Outputs four
NEW entity types — people, projects, threads, glossary — and writes them under
``<target_repo>/memory/{people,projects,threads,glossary}/``.

Failure mode (per spec): if Claude is unreachable or returns malformed JSON,
log a warning and return empty entities. Never break ``tmi wrap``.

Idempotency: re-running on the same (meeting_id, content) pair must produce
identical files. The writers in ``tmi.memory`` are responsible for dedupe by
``(meeting_id, content_hash)`` so this module's contract is just "extract and
hand off".
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Mirrors observer/__init__.py FENCED_JSON_RE — kept local so future tweaks to
# the extractor's output protocol don't ripple into the observer protocol.
FENCED_JSON_RE = re.compile(r"```json\s*\n(.*?)\n```", re.DOTALL)

# Cap the prompt size we send to Claude. Long meetings get truncated from the
# end with a marker, so the extractor still gets the start (where definitions
# usually live). 200K chars ≈ 50K tokens ≈ comfortable for a single Sonnet call.
DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000
DEFAULT_TIMEOUT_SECONDS = 90


@dataclass(frozen=True)
class PersonMention:
    alias: str
    context: str
    transcript_lines: tuple[int, ...] = ()


@dataclass(frozen=True)
class ProjectMention:
    slug: str
    name: str
    context: str
    transcript_lines: tuple[int, ...] = ()


@dataclass(frozen=True)
class ThreadMention:
    topic: str
    title: str
    summary: str
    open_questions: tuple[str, ...] = ()
    transcript_lines: tuple[int, ...] = ()


@dataclass(frozen=True)
class GlossaryTerm:
    term: str
    definition: str
    transcript_lines: tuple[int, ...] = ()


@dataclass
class ExtractedEntities:
    people: list[PersonMention] = field(default_factory=list)
    projects: list[ProjectMention] = field(default_factory=list)
    threads: list[ThreadMention] = field(default_factory=list)
    glossary: list[GlossaryTerm] = field(default_factory=list)

    @classmethod
    def empty(cls) -> "ExtractedEntities":
        return cls()

    def is_empty(self) -> bool:
        return not (self.people or self.projects or self.threads or self.glossary)

    def counts(self) -> dict[str, int]:
        return {
            "people": len(self.people),
            "projects": len(self.projects),
            "threads": len(self.threads),
            "glossary": len(self.glossary),
        }


# ----------------------------------------------------------------------
# Prompt + transcript prep


PROMPT_PATH = Path(__file__).parent / "prompts" / "extract.txt"


def _load_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


def _number_transcript(transcript: str, *, max_chars: int = DEFAULT_MAX_TRANSCRIPT_CHARS) -> str:
    """Prefix each non-empty line with ``L<n>: `` (1-based). Truncate from the
    tail if over ``max_chars`` and append a marker so the LLM knows it was cut.
    """
    if not transcript:
        return ""
    lines = transcript.splitlines()
    numbered = []
    for i, line in enumerate(lines, start=1):
        numbered.append(f"L{i}: {line}")
    out = "\n".join(numbered)
    if len(out) > max_chars:
        out = out[:max_chars] + "\n[... transcript truncated for length ...]"
    return out


def build_prompt(transcript: str, *, max_chars: int = DEFAULT_MAX_TRANSCRIPT_CHARS) -> str:
    """Concatenate the locked extraction prompt + line-numbered transcript."""
    return _load_prompt() + _number_transcript(transcript, max_chars=max_chars) + "\n"


# ----------------------------------------------------------------------
# Claude CLI wrapper


def _run_claude(
    claude_cli_path: Path,
    prompt: str,
    *,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
) -> str | None:
    """Invoke Claude in headless mode. Returns stdout text, or None on any error.

    Uses ``--print`` (one-shot) and feeds the full prompt on stdin so we don't
    blow out the OS arg-length limit on long transcripts. We do NOT pass
    ``--output-format json`` here — the prompt itself instructs Claude to emit a
    fenced JSON block, mirroring the observer protocol.
    """
    cmd = [str(claude_cli_path), "--print"]
    try:
        proc = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError:
        logger.warning("extractor: claude CLI not found at %s; skipping extraction", claude_cli_path)
        return None
    except subprocess.TimeoutExpired:
        logger.warning("extractor: claude timed out after %ss; skipping extraction", timeout)
        return None
    except OSError as e:
        logger.warning("extractor: claude subprocess failed (%s); skipping extraction", e)
        return None

    if proc.returncode != 0:
        # Truncate stderr so we don't fill the log with a multi-MB dump.
        stderr_snippet = (proc.stderr or "")[:400]
        logger.warning(
            "extractor: claude returned %s; skipping extraction. stderr=%s",
            proc.returncode,
            stderr_snippet,
        )
        return None

    return proc.stdout


# ----------------------------------------------------------------------
# JSON parsing


def _coerce_int_list(raw: Any) -> tuple[int, ...]:
    if not isinstance(raw, list):
        return ()
    out: list[int] = []
    for v in raw:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    return tuple(out)


def _coerce_str_list(raw: Any) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return ()
    return tuple(str(v).strip() for v in raw if str(v).strip())


_KEBAB_SAFE = re.compile(r"[^a-z0-9]+")


def _kebab(value: Any, fallback: str) -> str:
    s = str(value or "").strip().lower()
    s = _KEBAB_SAFE.sub("-", s).strip("-")
    return s or fallback


def parse_extracted_json(payload: str) -> ExtractedEntities:
    """Parse the LLM output. Tolerant: prefers a fenced ``json`` block but
    falls back to raw JSON. Returns empty on any failure.
    """
    if not payload:
        return ExtractedEntities.empty()

    obj: Any | None = None

    # Prefer fenced block.
    m = FENCED_JSON_RE.search(payload)
    if m:
        try:
            obj = json.loads(m.group(1))
        except json.JSONDecodeError:
            obj = None

    # Fall back: try the whole payload as JSON.
    if obj is None:
        try:
            obj = json.loads(payload.strip())
        except json.JSONDecodeError:
            logger.warning("extractor: could not parse JSON from claude output; treating as empty")
            return ExtractedEntities.empty()

    if not isinstance(obj, dict):
        logger.warning("extractor: top-level JSON not an object; treating as empty")
        return ExtractedEntities.empty()

    people: list[PersonMention] = []
    for raw in obj.get("people") or []:
        if not isinstance(raw, dict):
            continue
        alias = _kebab(raw.get("alias"), fallback="")
        if not alias:
            continue
        people.append(
            PersonMention(
                alias=alias,
                context=str(raw.get("context") or "").strip(),
                transcript_lines=_coerce_int_list(raw.get("transcript_lines")),
            )
        )

    projects: list[ProjectMention] = []
    for raw in obj.get("projects") or []:
        if not isinstance(raw, dict):
            continue
        slug = _kebab(raw.get("slug") or raw.get("name"), fallback="")
        if not slug:
            continue
        projects.append(
            ProjectMention(
                slug=slug,
                name=str(raw.get("name") or slug).strip(),
                context=str(raw.get("context") or "").strip(),
                transcript_lines=_coerce_int_list(raw.get("transcript_lines")),
            )
        )

    threads: list[ThreadMention] = []
    for raw in obj.get("threads") or []:
        if not isinstance(raw, dict):
            continue
        topic = _kebab(raw.get("topic") or raw.get("title"), fallback="")
        if not topic:
            continue
        threads.append(
            ThreadMention(
                topic=topic,
                title=str(raw.get("title") or topic).strip(),
                summary=str(raw.get("summary") or "").strip(),
                open_questions=_coerce_str_list(raw.get("open_questions")),
                transcript_lines=_coerce_int_list(raw.get("transcript_lines")),
            )
        )

    glossary: list[GlossaryTerm] = []
    for raw in obj.get("glossary") or []:
        if not isinstance(raw, dict):
            continue
        term = _kebab(raw.get("term"), fallback="")
        if not term:
            continue
        glossary.append(
            GlossaryTerm(
                term=term,
                definition=str(raw.get("definition") or "").strip(),
                transcript_lines=_coerce_int_list(raw.get("transcript_lines")),
            )
        )

    return ExtractedEntities(people=people, projects=projects, threads=threads, glossary=glossary)


# ----------------------------------------------------------------------
# Public entry


def extract_from_meeting(
    meeting_path: Path,
    transcript: str,
    claude_cli_path: Path,
    *,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
    max_transcript_chars: int = DEFAULT_MAX_TRANSCRIPT_CHARS,
) -> ExtractedEntities:
    """One LLM call. Returns parsed entities. Empty on any error.

    Args:
        meeting_path: meeting directory (currently unused, but reserved for
            future per-meeting context — e.g. attaching past extractions to
            disambiguate aliases).
        transcript: full meeting transcript as a single string.
        claude_cli_path: absolute path to the ``claude`` binary.
        timeout: seconds to wait for the subprocess.
        max_transcript_chars: cap before truncation.
    """
    if not transcript or not transcript.strip():
        logger.info("extractor: empty transcript; nothing to extract")
        return ExtractedEntities.empty()

    prompt = build_prompt(transcript, max_chars=max_transcript_chars)
    raw = _run_claude(claude_cli_path, prompt, timeout=timeout)
    if raw is None:
        return ExtractedEntities.empty()
    return parse_extracted_json(raw)


__all__ = [
    "PersonMention",
    "ProjectMention",
    "ThreadMention",
    "GlossaryTerm",
    "ExtractedEntities",
    "extract_from_meeting",
    "parse_extracted_json",
    "build_prompt",
    "PROMPT_PATH",
    "DEFAULT_MAX_TRANSCRIPT_CHARS",
    "DEFAULT_TIMEOUT_SECONDS",
]
