---
description: Use when the user asks to add a new method to the StorageAdapter interface. Updates the interface in packages/storage/src/types/adapter.ts, implements in memory and sqlite adapters, and adds the method to the shared test suite. Triggers when user mentions "add a method to storage", "extend StorageAdapter", "new adapter operation".
---

# Add a StorageAdapter method

When invoked:

1. Ask for: method name, signature (filter input + return type), which collection (Documents/Assets/Users/Sessions/Redirects).
2. Update `packages/storage/src/types/adapter.ts` with the new method signature (with JSDoc).
3. Implement in `packages/storage/src/memory/memory-adapter.ts`.
4. Implement in `packages/storage/src/sqlite/operations/<collection>.ts`.
5. Wire into `packages/storage/src/sqlite/sqlite-adapter.ts`.
6. Add coverage in `internal/test-utils/src/adapter-test-suite.ts` so all adapters get tested.
7. Run `pnpm test` and `pnpm typecheck`.
8. Document the addition in CHANGELOG draft.

## Critical rules

- StorageAdapter interface = stable contract. Adding a method = MINOR semver bump (use `?:` to make it optional and keep backward compat).
- Method MUST be implemented in BOTH memory and sqlite adapters.
- The shared test suite ensures custom user adapters can be validated.
