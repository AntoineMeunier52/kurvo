---
description: Use when the user asks to add a new block type to Kurvo. Creates Hero.def.ts + Hero.vue + Hero.test.ts in packages/vue/src/editor/src/blocks/ or examples/, following the schema-first convention with fields.x() helpers and InferBlockProps inference.
---

# Add a new Kurvo block

When invoked:

1. Ask the user for: block name (PascalCase), category (`sections`/`content`/`interactive`/`layout`), short description.
2. Ask for the fields needed (text, image, link, etc.) and which ones are required.
3. Ask for slots if any (which block types are accepted).
4. Generate three files in the appropriate folder:
   - `<Name>.def.ts` — defineBlock with fields.x() helpers
   - `<Name>.vue` — Vue 3 component with InferBlockProps<typeof <Name>>
   - `<Name>.test.ts` — basic Vitest test
5. Add export line to the parent `index.ts`.
6. Run `pnpm typecheck` to verify.
7. Suggest a unit test scenario.

## Conventions

- Use `fields.text()`, `fields.select()` helpers (NEVER raw `{ type: 'text' }`).
- Vue component imports `InferBlockProps<typeof <Name>>` from `@kurvo/core`.
- `<SlotRenderer name="...">` for slots.
- No `<EditableText>` (V1 = sidebar-first, no inline editing).
- Tailwind classes for styling.
- File naming : `.def.ts` and `.vue` PascalCase.
