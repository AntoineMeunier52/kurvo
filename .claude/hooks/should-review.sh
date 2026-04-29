#!/bin/bash
# Lance le subagent code-optimizer sur le diff actuel et bloque si bugs trouvés.

# 0. Setup logs
mkdir -p .claude/logs
log_file=".claude/logs/reviews.log"

# 1. Anti-boucle infinie : DOIT être en premier (lire stdin avant tout exit)
input=$(cat)
if echo "$input" | jq -e '.stop_hook_active == true' > /dev/null 2>&1; then
  exit 0
fi

# 2. Filtres : check working tree d'abord, fallback sur dernier commit
diff_range="HEAD"
if ! git diff HEAD --name-only 2>/dev/null | grep -qE '\.(ts|tsx|js|jsx|vue)$'; then
  # Pas de fichier TS/JS/Vue dans le working tree, check le dernier commit
  if ! git diff HEAD~1 HEAD --name-only 2>/dev/null | grep -qE '\.(ts|tsx|js|jsx|vue)$'; then
    exit 0
  fi
  diff_range="HEAD~1 HEAD"
fi

diff_lines=$(git diff $diff_range --shortstat 2>/dev/null | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+')
if [ -z "$diff_lines" ] || [ "$diff_lines" -lt 5 ]; then
  # Try the other range as fallback
  if [ "$diff_range" = "HEAD" ]; then
    diff_lines=$(git diff HEAD~1 HEAD --shortstat 2>/dev/null | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+')
    if [ -z "$diff_lines" ] || [ "$diff_lines" -lt 5 ]; then
      exit 0
    fi
    diff_range="HEAD~1 HEAD"
  else
    exit 0
  fi
fi

# 3. Debounce 60s
last_review_file=".claude/.last-review"
now=$(date +%s)
if [ -f "$last_review_file" ]; then
  last=$(cat "$last_review_file")
  if [ $((now - last)) -lt 60 ]; then
    exit 0
  fi
fi
echo "$now" > "$last_review_file"

# 4. Lance le subagent et capture sa sortie
prompt="Review the changes from this turn. Run \`git diff $diff_range\` to see them. Apply the méthode de review (5 étapes obligatoires) before concluding. Report findings in the structured format."

review=$(claude -p --agent code-optimizer "$prompt" 2>/dev/null)

# 5. Logger pour relecture après coup
{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') (range: $diff_range, lines: $diff_lines) ==="
  echo "$review"
  echo ""
} >> "$log_file"

# 6. Si bugs détectés, bloque via exit 2
if echo "$review" | grep -qE '🔴|🟠'; then
  echo "Code review found issues:" >&2
  echo "$review" >&2
  exit 2
fi

exit 0