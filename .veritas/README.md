# Veritas Starter Kit

This repo was bootstrapped for `Fieldwork` with a conservative starter kit for agent-guided development.

## Generated Files

- `.veritas/README.md`
- `.veritas/GOVERNANCE.md`
- `.veritas/repo-map.json`
- `.veritas/repo-standards/default.repo-standards.json`
- `.veritas/authority/default.authority-settings.json`

## Inferred Repo Shape

- Repo kind: `application`
- Source roots: `src/` (`app.cli-server` and `app.browser`)
- Tooling roots: `none`
- Test roots: `test/`
- GitHub workflows detected: `no`
- Matching scripts seen: `verify`, `test`, `build`

## What To Do Next

1. Keep `app.cli-server`, `app.browser`, and `test/` routing aligned with `.veritas/repo-map.json`.
2. Keep `npm run verify:static` non-recursive; `npm run verify` adds readiness after it.
3. Keep uncertain requirements in Observe or Guide until evidence shows they should be required.



## Suggested Commands

```bash
npx @kontourai/veritas readiness --working-tree
npx @kontourai/veritas readiness --check coverage --working-tree
npx @kontourai/veritas integrations codex status
npx @kontourai/veritas attest bootstrap --actor <authority-id> --approval-ref <human-approval-reference> --non-interactive
```

If you prefer explicit paths:

```bash
npx @kontourai/veritas readiness --check evidence \
  --repo-map ./.veritas/repo-map.json \
  --repo-standards ./.veritas/repo-standards/default.repo-standards.json \
  package.json
```

## Suggested Evidence Check

`npm run verify:static`

## Work-Area Evidence Routing

The repo map distinguishes `app.cli-server`, `app.browser`, and `verification.tests`, while all areas share the required non-recursive `npm run verify:static` evidence check.

## Why This Exists

The goal is to give developers and agents just-in-time repo guidance from day one, while keeping review and CI grounded in the same starter standards.
