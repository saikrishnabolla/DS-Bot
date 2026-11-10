#!/bin/sh
# Bring the current branch up to date with origin/dev.
#
#   scripts/merge-dev.sh
#
# ds-bot/office.js is generated from ds-bot/src/office, so a conflict in it is never
# resolved by hand: it is taken from dev and rebuilt once the sources are merged.
# Any other conflict stops the script with the merge still open, to be resolved
# and committed as usual.
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "merge-dev: commit or stash your changes first" >&2
  exit 1
fi

git fetch origin dev
if git merge --no-edit origin/dev; then
  merged=1
else
  merged=0
fi

if [ "$merged" -eq 0 ]; then
  if git diff --name-only --diff-filter=U | grep -qx 'ds-bot/office.js'; then
    git checkout --theirs -- ds-bot/office.js
    git add ds-bot/office.js
  fi
  left="$(git diff --name-only --diff-filter=U)"
  if [ -n "$left" ]; then
    echo "merge-dev: resolve these, then run 'npm run build' in ds-bot and commit:" >&2
    echo "$left" >&2
    exit 1
  fi
fi

# A changed lockfile, or a checkout that never installed, needs `npm ci` before the build.
if [ ! -d ds-bot/node_modules ] || ! git diff --quiet ORIG_HEAD -- ds-bot/package-lock.json; then
  (cd ds-bot && npm ci --no-fund --no-audit >/dev/null)
fi
# The merged Office sources may differ from both sides' bundle even without a conflict.
(cd ds-bot && npm run build >/dev/null)
git add ds-bot/office.js
if [ "$merged" -eq 0 ]; then
  git commit --no-edit
elif ! git diff --cached --quiet; then
  git commit -m "Rebuild office.js after merging dev"
fi
echo "merge-dev: up to date with origin/dev"
