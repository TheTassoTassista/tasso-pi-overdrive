#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: worktree-new.sh BRANCH [BASE_REF]" >&2
  exit 2
fi
repo=$(git rev-parse --show-toplevel)
branch=$1
base_ref=${2:-HEAD}
if ! git check-ref-format --branch "$branch" >/dev/null 2>&1; then
  echo "Invalid branch name: $branch" >&2
  exit 2
fi
repo_name=$(basename -- "$repo")
safe_branch=$(printf '%s' "$branch" | tr '/[:space:]' '--' | tr -cd '[:alnum:]_.-')
worktree_root=${PI_OVERDRIVE_WORKTREE_ROOT:-"$(dirname -- "$repo")/worktrees/$repo_name"}
worktree="$worktree_root/$safe_branch"
if [[ -e "$worktree" ]]; then
  echo "Worktree path already exists: $worktree" >&2
  exit 1
fi
install -d -- "$worktree_root"
git worktree add -b "$branch" "$worktree" "$base_ref"
port_offset=$(printf '%s' "$repo_name-$branch" | cksum | awk '{print $1 % 1000}')
port=$((30000 + port_offset))
db_name=$(printf 'pi_%s_%s' "$repo_name" "$safe_branch" | tr '.-' '__' | cut -c1-60)
profile="$HOME/.local/share/pi-overdrive/browser-profiles/$repo_name/$safe_branch"
printf 'Worktree: %s\nBranch: %s\nSuggested port: %s\nSuggested DB: %s\nSuggested browser profile: %s\n' "$worktree" "$branch" "$port" "$db_name" "$profile"
