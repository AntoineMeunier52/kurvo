---
description: Use when the user makes an architectural or product decision they want to document. Creates or updates a note in cms-project-docs/, adds the decision to the central decisions table in README.md, and updates Trade-offs acceptes.md if relevant.
---

# Document a Kurvo decision

When invoked:

1. Ask for: decision summary (1 sentence), category (architecture/produit/strategie/dx), rationale.
2. Identify the right note in `cms-project-docs/` to enrich (or create one).
3. Add a new row to the decisions table in `cms-project-docs/README.md` (next number).
4. If the decision has trade-offs, add an entry in `cms-project-docs/07-decisions-techniques/Trade-offs acceptes.md`.
5. Update the `last-updated` field of touched notes.
6. Suggest related notes that may need updating.

## Format

Decision row format:
| <number> | <Decision summary> | ✅ acte | [[<note name>]] |

If the decision is conditional or to revisit:
| <number> | <Summary> | ⚠ acte <condition> | [[<note>]] |
