# Publishing

Releases publish to three registries from `.github/workflows/release.yml`:

- **VS Code Marketplace**, used by Microsoft's VS Code.
- **Open VSX**, used by Cursor, VSCodium, Windsurf and other VS Code forks.
- **JetBrains Marketplace**, for the `dev.pkgguard` plugin (IntelliJ IDEA, WebStorm and other JetBrains IDEs).

The VS Code extension uses the publisher/namespace `albiummid` (`publisher` in `platforms/vscode/package.json`).

## One-time setup

### VS Code Marketplace
CI publishes with [Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) (`vsce publish --oidc`): GitHub's OIDC token is exchanged for a short-lived Marketplace credential, so there is no PAT or secret to store or rotate.

1. Create the publisher `albiummid` at https://marketplace.visualstudio.com/manage.
2. Open the publisher, select **Trusted Publishing**, expand **Create**, and enter:
   - Repository owner: `albiummid`
   - Repository: `pkg-guard`
   - Workflow: `release.yml`
   - Environment: leave empty

Without a policy, the `publish-marketplace` job fails (it does not skip). For a one-off manual publish, use `yarn vsce login albiummid` with a PAT, or upload the `.vsix` on the publisher page.

### Open VSX
1. Sign in at https://open-vsx.org with GitHub, then link your Eclipse account and sign the Publisher Agreement (Settings > Profile).
2. Create an access token under Settings > Access Tokens.
3. Create the namespace once: `yarn ovsx create-namespace albiummid --pat <token>`.
4. Add the token as the repo secret `OVSX_PAT`.

Check the token locally with `yarn ovsx verify-pat albiummid`.

### JetBrains Marketplace
The plugin must already exist on the Marketplace (the first version is uploaded by hand at https://plugins.jetbrains.com/plugin/add); CI only publishes new versions.

1. Create a token at https://plugins.jetbrains.com/author/me/tokens and add it as the repo secret `JETBRAINS_PUBLISH_TOKEN`.
2. Create a signing key and certificate (keep the files and passphrase somewhere safe; every release must be signed with the same key):
   ```
   openssl genpkey -aes-256-cbc -algorithm RSA -out private_encrypted.pem -pkeyopt rsa_keygen_bits:4096
   openssl rsa -in private_encrypted.pem -out private.pem
   openssl req -key private.pem -new -x509 -days 3650 -out chain.crt
   ```
3. Add the repo secrets `JETBRAINS_CERTIFICATE_CHAIN` (the whole of `chain.crt`), `JETBRAINS_PRIVATE_KEY` (the whole of `private.pem`) and `JETBRAINS_PRIVATE_KEY_PASSWORD` (the passphrase).

With a token but no signing secrets, the JetBrains job fails instead of publishing an unsigned plugin. The listing's "What's New" comes from this version's CHANGELOG.md section (`yarn cli changelog notes <version> --html`).

## Releasing
```
yarn cli release patch|minor|major --push
```
The `v*` tag starts the Release workflow. It builds, tests and runs the JetBrains plugin verifier, creates the GitHub release, then runs `publish-marketplace`, `publish-openvsx` and `publish-jetbrains` as independent jobs. The Open VSX and JetBrains jobs log a warning and skip when their token secret is missing. Tags with a `-` suffix (prereleases) are never published.

## Re-publishing one registry
If one registry failed, open Actions > Release > **Run workflow**, enter the existing tag (for example `v0.1.3`) and choose the target `marketplace`, `openvsx`, `jetbrains` or `all`. This rebuilds that tag and publishes it without creating another GitHub release. Every registry rejects a version it already has, so this only helps for a registry the version never reached.
