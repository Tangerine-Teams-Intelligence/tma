## What changed

One sentence describing the change.

## Why

Reference the issue this fixes or the design decision this implements.

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Docs only
- [ ] Schema change (must update INTERFACES.md)
- [ ] Refactor (no behavior change)

## Testing

- [ ] Unit tests pass (`pytest` for Python / `npm test` for bot)
- [ ] E2E smoke passes (`bash tests/smoke_e2e.sh`)
- [ ] Manual repro of the original issue confirmed fixed

## Schema impact

- [ ] No schema change
- [ ] Backwards-compatible additive change (new optional field)
- [ ] Breaking change — INTERFACES.md version bumped, migration noted

## Checklist

- [ ] Code style: `ruff check` and (where applicable) `npm run lint` clean
- [ ] No secrets / tokens in diff
- [ ] Updated docs if behavior changed (README / SETUP / CONTRIBUTING)
- [ ] PR title follows Conventional Commits (`feat:`, `fix:`, `docs:`, etc.)
