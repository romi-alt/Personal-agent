#!/usr/bin/env bash
# Configures `main` as the default branch and protects it. Run by a repository ADMIN with an authenticated gh CLI:
#   gh auth login
#   scripts/github/protect-main.sh romi-alt/Personal-agent
# Idempotent. Requires the CI workflow (job "check") to have run at least once so GitHub knows the status-check name.
set -euo pipefail
REPO="${1:?usage: protect-main.sh <owner/repo>}"

echo "Setting default branch to main on $REPO"
gh api -X PATCH "repos/$REPO" -f default_branch=main --jq '.default_branch'

echo "Protecting main (PR required, status check 'check' required, no force-push, no deletion)"
gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["check"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "dismiss_stale_reviews": true },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
echo "Done. Verify: gh api repos/$REPO/branches/main/protection --jq '.required_status_checks.contexts'"
