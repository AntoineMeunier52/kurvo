---
description: Use when finishing tasks in an implementation phase to update the checklist, log progress, and check exit criteria. Updates cms-project-docs/10-implementation/Phase X.md and the README progress table.
---

# Update Kurvo phase progress

When invoked:

1. Ask which phase (0-8) and which sub-tasks were completed.
2. Update checkboxes in `cms-project-docs/10-implementation/Phase <N> — <name>.md`.
3. If phase has notes/code samples to capture, add them to the "Notes d'implementation" section.
4. Update `last-updated` field.
5. Update `cms-project-docs/10-implementation/README.md` log table with current week + phase.
6. If exit criteria are met, change phase status from `wip` to `done` and suggest moving to next phase.
