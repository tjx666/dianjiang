---
name: release
description: Publish a new dianjiang version to npm, tag it, and upgrade the local install. Use when the user asks to release, publish, or cut a version (发版, 发新版本).
---

# Releasing dianjiang

Finish everything except the upload before asking for an npm OTP. Ask for the
code exactly once, when publishing is the only step left. An OTP lives about
30 seconds, so a code that arrives while checks are still running is wasted.

## 1. Prepare (no OTP yet)

1. Merge the feature PRs being released. Bump the version on a
   `release/vX.Y.Z` branch, using semver: a new harness or command is a minor
   bump; fixes are a patch bump. The release commit changes only
   `package.json`, as `chore: release vX.Y.Z`.
2. In that worktree, run `bun run check`, `bun test`, and
   `bun run test:package`. The package test runs `prepack`, which leaves a
   fresh `dist/` behind.
3. Open and merge the release PR, then ask the user for the OTP.

## 2. Publish (the moment the OTP arrives)

Checks already ran on this commit, so skip `prepublishOnly` and upload directly.
Authenticated registry requests intermittently hang or return 503 while
anonymous ones succeed. A hung `npm whoami` does not mean the token is bad, so
do not ask the user to `npm login`. Retry fast within the OTP window:

```zsh
start=$SECONDS
while (( SECONDS - start < 45 )); do
  out=$(timeout 20 npm publish --otp="$OTP" --ignore-scripts --fetch-timeout=10000 --fetch-retries=0 2>&1)
  [[ $? -eq 0 ]] && { echo "$out" | grep '^+ '; break; }
  echo "$out" | grep -qiE 'previously published|cannot publish over' && { echo published; break; }
  echo "$out" | grep -q EOTP && { echo 'OTP rejected'; break; }
done
```

Only an `EOTP` result needs a new code. Ask for it in one message, together
with any other blocker.

## 3. Finish

- Tag the release merge commit: `git tag -a vX.Y.Z origin/main -m vX.Y.Z`,
  then push the tag. The repository publishes no GitHub Releases.
- The registry can take about a minute to show the new version. Poll
  `https://registry.npmjs.org/dianjiang` in the background until
  `dist-tags.latest` changes.
- Upgrade the local install yourself. Resolve it with
  `readlink -f "$(which dianjiang)"` before choosing a command. Today it is a
  `bun link` to the primary checkout, so run `git pull --ff-only && bun run build`
  there.
