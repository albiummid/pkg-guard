# Demo recordings

Referenced by the READMEs. Record at ~800px wide, under 5 MB each, and use these exact names:

| File | Shows |
|---|---|
| `vscode-package-json-with-sidebar.png` | Hero screenshot for the VS Code Marketplace listing and the root README |
| `jetbrains-package-json-with-sidebar.png` | Hero screenshot for the JetBrains listing |
| `vscode-inline.gif` | Opening a `package.json`: inline warnings, hover, quick fix to the fixed version |
| `vscode-sidebar.gif` | Activity bar → Pkg Guard: needs-attention list, update to latest, changelog, compatibility check |
| `jetbrains-inline.gif` | Opening a `package.json`: inline warnings, Alt+Enter fix |
| `jetbrains-toolwindow.gif` | **Pkg Guard** tool window: update, changelog, compatibility check |

The VS Code README links to these through `raw.githubusercontent.com/albiummid/pkg-guard/master/docs/media/`, so they must be pushed to `master` before they show in the Marketplace listing.

To record them, use the demo project in [`examples/demo-project/`](../../examples/demo-project): it has setup steps and a storyboard for each GIF.
