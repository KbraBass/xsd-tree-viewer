# Publishing

The project has two release destinations:

- [GitHub](https://github.com/KbraBass/xsd-tree-viewer) for source, tags, and
  downloadable VSIX files.
- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=KbraBass.xsd-tree-viewer)
  for extension installs.

## Release Workflow

The GitHub Actions **Release** workflow is the normal path. Run it from
**Actions -> Release -> Run workflow** with either:

- `bump`: `patch`, `minor`, or `major`;
- `version`: an exact semantic version, which overrides `bump`;
- `dry_run`: package and upload the VSIX as an artifact without committing,
  tagging, or publishing.

The workflow installs dependencies, builds, runs tests, packages the VSIX,
creates a GitHub Release with generated notes, and optionally publishes to the
Marketplace when the `VSCE_PAT` repository secret is present.

## Local Release Check

```sh
npm ci
npm run build
npm test
npm run package
```

The package command uses [`README.vsix.md`](../README.vsix.md) for the
Marketplace-facing extension page and writes `xsd-tree-viewer-<version>.vsix`.

Inspect the package before publishing:

```sh
npx --yes @vscode/vsce@3 ls --readme-path README.vsix.md
code --install-extension xsd-tree-viewer-<version>.vsix
```

## Marketplace Setup

The publisher in `package.json` is `KbraBass`, so the extension ID is
`KbraBass.xsd-tree-viewer`.

To enable automated Marketplace publishing:

1. Create or own the `KbraBass` publisher at
   <https://marketplace.visualstudio.com/manage>.
2. Create an Azure DevOps PAT with Marketplace Manage permission.
3. Add it to GitHub repository secrets as `VSCE_PAT`.

The release workflow skips the Marketplace step until that secret exists.

## Manual GitHub Release

For a manual release, build and test locally, then push the version commit and
create a GitHub release with generated notes:

```sh
git add -A
git commit -m "Release version <version>"
git tag -a v<version> -m "v<version>"
git push origin main --follow-tags
gh release create v<version> \
  xsd-tree-viewer-<version>.vsix \
  --title "v<version>" \
  --generate-notes
```

## Package Contents

The VSIX contains the compiled extension, `README.vsix.md` as its package
README, `LICENSE`, and the files required by the extension. Source files,
tests, build output for test compilation, and repository documentation are
excluded by `.vscodeignore`.
