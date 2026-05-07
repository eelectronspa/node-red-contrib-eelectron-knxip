# Publishing checklist

The repo is **GitHub-public** today. The package is **not** on the public npm
registry yet, so it does not surface inside Node-RED's Palette Manager or on
flows.nodered.org. Publishing to npm is the step that flips that.

Before publishing the first time, get clearance from eelectron management —
the package name uses the eelectron brand, and the repo lives under the
`eelectronspa` GitHub organization, so this is an organizational decision
rather than a personal one.

## What's already prepared

- `package.json` carries `repository`, `homepage`, and `bugs` URLs pointing
  to the public GitHub repo, so the npm page will link back correctly.
- `package.json#files` whitelists only `dist/`, `examples/`, `README.md`,
  `LICENSE`, `NOTICE` (≈175 kB compressed). No tests, fixtures, or secrets
  ship — verified with `npm pack --dry-run`.
- `.github/workflows/release.yml` already builds, tests, and creates GitHub
  Releases on every `v*.*.*` tag. The workflow has an optional **Publish to
  npm** step that is *skipped* until you add the secret described below.
- `.gitignore` excludes the local debugging scripts that shouldn't ship.

## Steps when management approves

1. Create or sign into an npm account. Verify the email; npm requires it
   before the first publish.
2. Reserve / claim the package name once: `npm publish --access public`
   (run from the project root). For a scoped name `@eelectron/...` you
   would `npm publish --access public` exactly the same way.
3. In GitHub repo Settings → Secrets and variables → Actions, add a secret
   named `NPM_TOKEN`. Use an **Automation** token from npmjs.com (Account
   → Access Tokens → Generate Token → Automation). The release workflow
   reads it at job level and only runs the publish step when present.
4. From then on, publishing is automatic: `git tag -a vX.Y.Z -m "..."` +
   `git push origin vX.Y.Z` runs the workflow, which builds, tests, packs,
   creates the GitHub Release, and `npm publish`es the same tarball.

## Optional renaming for a personal fork

If at any point this needs to live as a personal project rather than an
eelectron one, the cleanest path is to rename the package, drop the
"eelectron" branding, and host under your own GitHub user:

- Rename package → e.g. `@jamel-86/node-red-contrib-knxip` (scoped).
- Strip the brand from `NOTICE`, `README.md`, node category labels, and
  the admin endpoint URL prefix `/eelectron-knxip-*` (Node-RED node type
  names too — those are flow-breaking renames, only do this on a fork
  intended for personal release).
- Re-target `repository` / `homepage` / `bugs` URLs.

This keeps the eelectron-branded version reserved for whatever the company
decides to do, and any personal release is clearly distinct.
