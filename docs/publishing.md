# Publishing the VS Code extension

Releases publish to two registries from `.github/workflows/release.yml`:

- **VS Code Marketplace**, used by Microsoft's VS Code.
- **Open VSX**, used by Cursor, VSCodium, Windsurf and other VS Code forks.

Both use the publisher/namespace `albiummid` (`publisher` in `platforms/vscode/package.json`).

## One-time setup

### VS Code Marketplace
1. Create the publisher `albiummid` at https://marketplace.visualstudio.com/manage.
2. In Azure DevOps (https://dev.azure.com), create a Personal Access Token: Organization **All accessible organizations**, scope **Marketplace > Manage**.
3. Add it as the repo secret `VSCE_PAT`.

### Open VSX
1. Sign in at https://open-vsx.org with GitHub, then link your Eclipse account and sign the Publisher Agreement (Settings > Profile).
2. Create an access token under Settings > Access Tokens.
3. Create the namespace once: `yarn ovsx create-namespace albiummid --pat <token>`.
4. Add the token as the repo secret `OVSX_PAT`.

Check a token locally with `yarn vsce verify-pat albiummid` or `yarn ovsx verify-pat albiummid`.

## Releasing
```
yarn cli release patch|minor|major --push
```
The `v*` tag starts the Release workflow. It builds and tests, creates the GitHub release, then runs `publish-marketplace` and `publish-openvsx` as independent jobs. A job with no token secret logs a warning and skips. Tags with a `-` suffix (prereleases) are never published.

## Re-publishing one registry
If one registry failed, open Actions > Release > **Run workflow**, enter the existing tag (for example `v0.1.3`) and choose the target `marketplace` or `openvsx`. This rebuilds that tag and publishes it without creating another GitHub release.
