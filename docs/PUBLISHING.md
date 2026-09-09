# Publishing XSD Tree Viewer

Two separate things are called "publishing" here, and they are independent:

1. **Source** — pushing this repository to GitHub.
2. **Extension** — shipping a `.vsix` to the Visual Studio Marketplace (and,
   optionally, Open VSX for VSCodium/Gitpod users).

You can do (1) without ever doing (2).

## Automated release (the normal path)

Releases are cut by the **Release** workflow
([`.github/workflows/release.yml`](../.github/workflows/release.yml)) — the
version bump, the `.vsix` build and the GitHub Release all happen on GitHub, so
nothing depends on a local toolchain.

1. Put the changes under the `## [Unreleased]` heading in
   [`CHANGELOG.md`](../CHANGELOG.md) as you merge them. That section becomes
   the release notes verbatim.
2. **Actions → Release → Run workflow**, and choose:
   - **bump** — `patch`, `minor` or `major` (default `patch`), or
   - **version** — an exact version such as `0.3.0`, which overrides the bump
   - **dry_run** — build and package only; nothing is bumped, tagged or
     released, and the `.vsix` is attached to the workflow run as an artifact

The workflow then, in order: installs and builds, runs the unit tests, applies
the version bump, refuses to continue if the tag already exists, renames
`## [Unreleased]` to `## [<version>] - <date>`, packages the `.vsix`, commits
the bump with the dated changelog, pushes the `v<version>` tag, and creates a
GitHub Release with the `.vsix` attached.

The `.vsix` is therefore downloadable from the repository's **Releases** page,
with no local build involved.

Use **dry_run** first when you have changed anything about packaging — it
exercises the whole pipeline and leaves no trace.

### Enabling the Marketplace step

The workflow's last step publishes to the Marketplace, and **skips itself while
the `VSCE_PAT` secret is absent** — so releases work from day one and start
publishing the moment you opt in. To enable it:

1. Set `publisher` in `package.json` to a real publisher ID (see below).
2. Add the PAT as a repository secret named `VSCE_PAT`
   (**Settings → Secrets and variables → Actions**).

Nothing else changes; the next release publishes.

## Before the first Marketplace publish

Two things in `package.json` must be settled first.

### `publisher` is still a placeholder

```json
"publisher": "xsd-tree-viewer"
```

This must be the ID of a **real Marketplace publisher** you control, not the
extension name. `vsce publish` fails otherwise. To create one:

1. Sign in to <https://marketplace.visualstudio.com/manage> with a Microsoft
   account — this creates the backing Azure DevOps organisation.
2. Create a publisher; the **ID** you choose is what goes in `package.json`
   (the display name is separate and can be changed later).
3. Set the field:

   ```json
   "publisher": "<your-publisher-id>"
   ```

A publisher ID cannot be renamed once extensions are published under it, and
the extension's Marketplace identity is `<publisher>.<name>` — so it is worth
a moment's thought.

### There is no icon yet

`vsce` warns when `icon` is missing, and the Marketplace listing falls back to
a generic placeholder. Add a **128×128 PNG** (larger is fine, square and PNG
are not optional — SVG is rejected):

```json
"icon": "images/icon.png"
```

Keep it out of `.vscodeignore` so it ships inside the `.vsix`.

## Personal access token

`vsce` authenticates with an Azure DevOps PAT, *not* a GitHub token:

1. In Azure DevOps, open **User settings → Personal access tokens**.
2. **New Token**, with:
   - Organization: **All accessible organizations** (this is the usual cause
     of a `401` at publish time — an org-scoped token will not work)
   - Scopes: **Custom defined → Marketplace → Manage**
3. Store it, then either `npx vsce login <publisher-id>` once, or pass
   `--pat <token>` / set `VSCE_PAT` per invocation.

Treat the token as a credential: never commit it, and prefer a short expiry.
For the automated release, store it as the `VSCE_PAT` repository secret rather
than on a developer machine.

## Manual release (fallback)

Only needed when the workflow cannot be used — for a local build, or to
inspect an artifact before it exists as a release.

```sh
# 1. Everything green
npm ci
npm run build
npm test
npm run test:webview          # optional; needs `npx playwright install chromium`

# 2. Version + notes
#    - bump "version" in package.json (semver)
#    - add a CHANGELOG.md section for it
npm version 0.3.0 --no-git-tag-version

# 3. Build the artifact and check what goes in it
npx @vscode/vsce ls            # lists every file that would ship
npx @vscode/vsce package       # writes xsd-tree-viewer-<version>.vsix

# 4. Install the artifact and actually use it
code --install-extension xsd-tree-viewer-<version>.vsix
#    Open a real .xsd, run "XSD Tree Viewer: Open Preview", expand a few
#    levels, click a "go to source" arrow, edit the file and watch it refresh.

# 5. Record the release
git add -A
git commit -m "Release version 0.3.0"
git tag -a v0.3.0 -m "v0.3.0"
git push origin main --follow-tags

# 6. Ship it
npx @vscode/vsce publish       # or: publish the .vsix by hand at
                               # https://marketplace.visualstudio.com/manage
```

`vsce publish` re-packages from the working tree — it does not upload the
`.vsix` you built in step 3. Publish from a clean tree so the two match.

`npm run package` runs `build`, `test` and `vsce package` together if you
prefer a single command.

### GitHub release

The `.vsix` is a useful attachment for anyone who wants to install without the
Marketplace:

```sh
gh release create v0.3.0 xsd-tree-viewer-0.3.0.vsix \
  --title "v0.3.0" --notes-file <(sed -n '/## \[0.3.0\]/,/## \[/p' CHANGELOG.md | sed '$d')
```

## Open VSX (optional)

VSCodium, Gitpod and Eclipse Theia install from Open VSX rather than the
Microsoft Marketplace. Publishing there is a separate account and token:

```sh
npx ovsx publish xsd-tree-viewer-<version>.vsix -p <open-vsx-token>
```

## What ships in the `.vsix`

`.vscodeignore` keeps sources, tests, build config and `docs/` out; the package
carries `dist/`, `package.json`, `README.md`, `CHANGELOG.md` and `LICENSE`.
Always confirm with `npx @vscode/vsce ls` before publishing — an accidentally
shipped `node_modules` or a missing `dist/` are both easy to miss.

Because `dist/` is git-ignored but *required* in the package, never publish
without running the build first. `npm run package` enforces that ordering.

Relative links in `README.md` (such as the one to `docs/SPEC.md`) are rewritten
to absolute GitHub URLs by `vsce`, using the `repository` field. That field is
set, so the links resolve on the Marketplace listing even though `docs/` itself
is not shipped.

## Versioning

Semantic versioning, with the usual extension convention that anything
user-visible gets at least a minor bump:

- **patch** — bug fixes, no behaviour change for anyone reading the preview
- **minor** — new commands, settings, rendering changes, resolver behaviour
- **major** — removing or renaming a command or setting

Keep `CHANGELOG.md` in the same commit as the version bump; the Marketplace
renders it as the extension's "Changelog" tab.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `ERROR Missing publisher name` | `publisher` still the placeholder, or no `--pat`/login |
| `401 Unauthorized` on publish | PAT not scoped to *all* organizations, or expired |
| `ERROR Make sure to edit the README.md` | the default template README is still in place |
| Extension installs but does nothing | `dist/` missing from the package — build before packaging |
| `Cannot find module 'vscode'` at runtime | `vscode` must stay in esbuild's `external`, never bundled |
| Relative README links 404 on the listing | `repository` field missing or wrong |
| Release workflow: `tag already exists` | that version was released before; pick another |
| Release notes say "No changelog entry found" | no `## [Unreleased]` section was present |
| Marketplace step logs "VSCE_PAT is not set" | expected until you add the secret |
