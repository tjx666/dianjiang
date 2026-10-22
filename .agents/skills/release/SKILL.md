---
name: release
description: Publish a new dianjiang version to npm, tag it, and upgrade the local install. Use when the user asks to release, publish, or cut a version (发版, 发新版本).
---

# Releasing dianjiang

Pushing a `vX.Y.Z` tag publishes the package.
`.github/workflows/publish.yml` uploads it through npm trusted publishing
(OIDC), so a normal release needs no npm token or OTP from the user.

## 1. Prepare

1. Merge the feature PRs being released. Bump the version on a
   `release/vX.Y.Z` branch, using semver: a new harness or command is a minor
   bump; fixes are a patch bump. The release commit changes only
   `package.json`, as `chore: release vX.Y.Z`.
2. In that worktree, run `bun run check`, `bun test`, and
   `bun run test:package`.
3. Open and merge the release PR.

## 2. Publish

1. Tag the release merge commit with `git tag -a vX.Y.Z origin/main -m vX.Y.Z`,
   then push the tag. The repository publishes no GitHub Releases.
2. Watch the `Publish` run in the background with
   `gh run watch <id> --exit-status`. The workflow fails before uploading
   when the tag does not match `package.json`.
3. Poll `https://registry.npmjs.org/dianjiang` in the background until
   `dist-tags.latest` changes. The registry can lag about a minute.

If the run fails, read its log before acting. Fix test or build failures on
`main` with a new patch version, because a pushed tag is never moved. An
OIDC or `E404`/`ENEEDAUTH` failure at `npm publish` means the trusted
publisher on npmjs.com is missing, expired, or does not allow `npm publish`.
Only the user can fix that there. Otherwise use the manual fallback below.

## Manual fallback (OTP)

Finish everything else first, then ask for the OTP exactly once, together
with any other blocker. An OTP lives about 30 seconds. Checks already ran, so
skip `prepublishOnly` and retry fast within the window. A hung `npm whoami`
does not mean the token is bad, so do not ask the user to `npm login`:

```zsh
start=$SECONDS
while (( SECONDS - start < 45 )); do
  out=$(timeout 20 npm publish --otp="$OTP" --ignore-scripts --fetch-timeout=10000 --fetch-retries=0 2>&1)
  [[ $? -eq 0 ]] && { echo "$out" | grep '^+ '; break; }
  echo "$out" | grep -qiE 'previously published|cannot publish over' && { echo published; break; }
  echo "$out" | grep -q EOTP && { echo 'OTP rejected'; break; }
done
```

Run it from a worktree at the tagged commit after `bun run build`, because
`--ignore-scripts` skips `prepack`.

## 3. Upgrade the local install

Upgrade it yourself. Resolve it with `readlink -f "$(which dianjiang)"`
before choosing a command. Today it is a `bun link` to the primary checkout,
so run `git pull --ff-only && bun run build` there.
