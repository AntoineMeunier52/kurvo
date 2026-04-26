# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Kurvo** is an open-source visual page builder for Vue. Editor-first, modular architecture. The editor IS the product — it takes blocks, outputs JSON. Everything else (storage, auth, backend) is opt-in layers.

**Stack**: TypeScript strict, Vue 3, `@vue/reactivity`, Tiptap, `@dnd-kit/vue`, Pinia, Vitest, unbuild, pnpm workspaces.

## Key Vocabulary

- **Document** = canonical editable content unit (page, article, product)
- **Page** = UI shorthand for "Document of collection `pages`" (the only collection in V1)
- **Block** = visual component inside a Document, defined via `defineBlock()`
- **Collection** = type of Document (`pages` V1, custom V2+)
- **Translation Group** = set of Documents linked by `translationGroupId` (one Document per language, NOT field-level localization)

## Commands

```bash
pnpm install          # install all workspace deps
pnpm dev              # parallel dev across all packages
pnpm build            # build all packages
pnpm test             # run all tests (Vitest)
pnpm lint             # lint all packages (ESLint)
pnpm typecheck        # typecheck all packages

# Per-package
pnpm --filter @kurvo/core test
pnpm --filter @kurvo/vue test

# Verify before claiming done
pnpm typecheck && pnpm test
```

## Architecture — Modular layers (opt-in)

```
Layer 0 — @kurvo/vue          THE PRODUCT. Editor + JSON output.
Layer 1 — @kurvo/storage      Opt-in. StorageAdapter interface + memory adapter.
           + future adapters   @kurvo/storage-sqlite, -postgres, -mysql (V1.5+)
Layer 2 — @kurvo/auth         Opt-in. Login, sessions, guards (V2)
Layer 3 — @kurvo/backend      Opt-in. Rich admin UI (V3)
Layer 4 — @kurvo/plugin-*     Opt-in. Plugins ecosystem (V4+)
```

V1 ships 2 packages:

```
@kurvo/core       → TS pure, zero Vue/DOM/Node deps. Types, defineBlock(), fields.x() helpers,
                    state (@vue/reactivity), serialization, validation, event bus.
                    Deps: @vue/reactivity, nanoid, zod.
@kurvo/vue        → <KurvoEditor /> component + <DocumentRenderer> (light sub-export).
  ./editor        → Heavy admin UI sub-export (canvas, inspector, dnd, tiptap, images-only assets).
```

### What V1 does NOT include

- No auth (dev handles their own)
- No SQLite adapter (suspended, V1.5+)
- No server handlers / REST API
- No CLI
- No Nuxt module (V1.5)
- No PDF/video/audio/font assets (images only: JPG, PNG, WebP, GIF)

### Dependency boundaries (strict)

| Package | May depend on | Must NOT depend on |
|---|---|---|
| `core` | `@vue/reactivity`, `nanoid`, `zod` only | Vue components, DOM, Node-specific, fetch |
| `vue` | `core` | — |

### Data flow (V1)

```
User action → Editor UI → core state (reactive) → JSON output
                                                      ↓
                                          (optional) StorageAdapter → user's DB
```

### Key design decisions

- **BlockTree V1**: tree-native `reactive<Block[]>` (not flat). May refactor to flat in V2 for shared blocks.
- **History**: linear stack, in-memory, full snapshot, action-based `commitChange()`, max 50 entries.
- **Editor**: sidebar-first (no inline editing V1). All field editing via Inspector panel.
- **i18n**: Translation Groups model — one Document per language, linked by `translationGroupId`.
- **Field DX**: schema-first via `defineBlock()` + `fields.x()` helpers. Type inference via `InferBlockProps<typeof Block>`. No codegen.
- **Assets V1**: images only (JPG, PNG, WebP, GIF). No `fields.file()`. No SVG.
- **Composables**: prefixed `useKurvoX()`, return `{ data, isLoading, error, refresh }`, filter object signature.

## Commit Convention (Conventional Commits, enforced by commitlint)

Format: `<type>(<scope>): <description>`

Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `style`, `perf`, `ci`, `build`, `revert`
Scopes: `core`, `vue`, `editor`, `deps`, `ci`, `release` (required by warning, enforced list)

Rules:
- Imperative present tense in English ("add", not "added")
- Subject line < 72 chars, no capital after `:`, no trailing period
- Scope should match the package or area affected

Examples:
```
chore: initial monorepo setup with pnpm workspaces
feat(core): add defineBlock and field helpers
fix(vue): prevent duplicate block ids on drop
test(core): add unit tests for BlockTree operations
refactor(editor): extract sidebar into composable
chore(deps): bump vitest to 4.2.0
```

## Coding Conventions

- TypeScript strict, no `any`. ESM only, no CJS.
- File naming: `.ts` kebab-case, `.vue` PascalCase.
- Tests mirror source in `test/` folders. `.test-d.ts` for type-level tests.
- `index.ts` of each package = strict public API surface. Internal modules not importable cross-package.
- Comments only when WHY is non-obvious. Never WHAT.
- `@vue/reactivity` imports centralized in `core/src/state/reactive.ts` (single file to touch if migrating).

## Workflow

- Read relevant `cms-project-docs/` notes BEFORE coding a feature — decision rationale lives there.
- Check `cms-project-docs/07-decisions-techniques/Trade-offs acceptes.md` when uncertain about design.
- Track progress via `cms-project-docs/10-implementation/Phase X.md` checklists.
- Don't add features beyond V1 scope — check `cms-project-docs/01-strategie/Scope MVP.md` and `Scope explicitement exclu V1.md`.
- Don't introduce deps without checking `cms-project-docs/04-architecture/Dependencies externes.md`.
- Don't bypass `index.ts` public surface to import internal modules cross-package.

## Useful Paths

- Product docs vault: `cms-project-docs/`
- Implementation phases: `cms-project-docs/10-implementation/`
- Decisions table (29 acted decisions): `cms-project-docs/README.md`
- Architecture details: `cms-project-docs/04-architecture/`
- Glossary: `cms-project-docs/09-ressources/Glossaire.md`
