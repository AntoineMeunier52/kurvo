---
description: Use when the user asks to add a new Vue composable to @kurvo/vue. Generates the composable file with the standard reactive { data, isLoading, error, refresh } pattern, using useKurvo() context, with filter object signature and SSR-friendly fetching.
---

# Add a Kurvo composable

When invoked:

1. Ask for: composable purpose, input filter shape, output type.
2. Create `packages/vue/src/composables/use-kurvo-<name>.ts` with:
   - Filter object signature accepting refs (auto-watch)
   - Returns `{ data, isLoading, error, refresh }`
   - Uses `useKurvo()` to get context
   - Errors go in `error` ref, NOT thrown
3. Export from `packages/vue/src/composables/index.ts`.
4. Add `.test.ts` in `packages/vue/test/composables/` using memoryAdapter.
5. Add JSDoc with usage example.

## Pattern reference

See `cms-project-docs/06-dx-api/Composables runtime.md` for the standard pattern.
