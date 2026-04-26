# Contributing

Thanks for poking at TMA. This is a side project with best-effort maintenance — PRs welcome, responses not instant.

## Dev setup

```bash
git clone https://github.com/Tangerine-Intelligence/tangerine-meeting-live
cd tangerine-meeting-live

# Python
pip install -e ".[dev]"

# Node
cd bot && npm install && npm run build && cd ..
```

Run the full test suite:

```bash
# Python
pytest -v

# Node
cd bot && npm test && cd ..
```

Lint + type-check:

```bash
ruff check src/ tests/
mypy src/tmi
cd bot && npm run lint && cd ..
```

## What to work on

- Issues tagged `good first issue` or `help wanted` on GitHub.
- Output adapters for tools other than Claude Code (Cursor, Aider, Obsidian) — see `src/tmi/adapters/base.py`.
- Input adapters beyond Discord (Zoom, Lark, Meet) — requires a new layer; discuss in an issue first.
- Observer prompt tuning. Real meeting transcripts + desired outputs are gold.

Please don't open a PR that:
- Adds a hosted dashboard, SaaS layer, or auth system. Out of v1 scope.
- Changes the file schema in `INTERFACES.md` without discussion. See §11 (versioning) in that doc first.
- Depends on a paid third-party service other than OpenAI Whisper.

## Code style

**Python**: `ruff` + `mypy --strict`. Settings in `pyproject.toml`. Line length 100. Type hints required on public APIs.

**TypeScript**: `eslint` + `prettier`. Settings in `bot/`. Use `strict: true` in `tsconfig`.

No hand-rolled formatters. If `ruff format` or `prettier` disagree with you, they win.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(cli): add --participants flag to tmi new
fix(bot): handle Discord reconnect during active capture
docs(setup): clarify Discord guild ID step
test(adapter): cover anchor-missing case in insert action
refactor(observer): split prep/observe/wrap into separate modules
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `perf`.

First line ≤72 chars. Body optional but welcome for non-trivial changes.

## Pull request process

1. Branch off `main`. One logical change per PR. Small PRs get merged faster.
2. Tests required:
   - New CLI command → test in `tests/test_<module>.py`
   - New bot behavior → test in `bot/tests/`
   - Schema change → update `INTERFACES.md` AND bump `schema_version`
3. Fill in the PR template (auto-populated).
4. CI must pass. If you need to skip a flaky test, mark it `@pytest.mark.skip(reason=...)` with justification in the PR body.
5. Maintainer reviews (best-effort, within a few days).

Do not squash-rebase into `main` yourself. Maintainer handles the merge.

## Schema changes

`INTERFACES.md` is the locked contract. Changes require:

1. Open an issue first. Justify why current schema doesn't work.
2. Bump `schema_version` in the affected file type.
3. Write a migration in `src/tmi/migrations/v<N>_to_v<N+1>.py` (even if no-op).
4. Update `INTERFACES.md` and note the change in Appendix B.

## Where to discuss

- Feature ideas, design questions: GitHub Discussions.
- Bugs, concrete proposals: GitHub Issues.
- Security: do NOT open a public issue. See [SECURITY.md](SECURITY.md).

## Maintainer

Daizhe Zou — daizhe@berkeley.edu. Response SLA: best-effort, this is a side project. Usually within a week.

## Code of Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Don't be a jerk.
