# Local macOS signing

The signed build uses the `global.sct Development` identity from your macOS Keychain.
The bundle identifier is `app.global-sct.desktop`.
Keep both values unchanged between builds.

## Create the local identity once

1. Open **Keychain Access** through Spotlight.
2. Select **Keychain Access → Certificate Assistant → Create a Certificate…** in the macOS menu bar.
3. Enter `global.sct Development` as the certificate name.
4. Select **Self Signed Root** as the identity type.
5. Select **Code Signing** as the certificate type.
6. Create the certificate in your **login** Keychain.
7. Open the certificate from **My Certificates**.
8. Expand **Trust**.
9. Set **Code Signing** to **Always Trust**.
10. Close the certificate window. Approve the macOS authentication prompt.

The certificate must appear with its private key under **My Certificates**.
Keep the private key in Keychain. Do not export it into the repository or commit it.
Each developer creates a local identity on their own Mac.

Check that macOS recognizes the identity:

```sh
security find-identity -v -p codesigning
```

The output must contain exactly one valid identity named `global.sct Development`.
The packaging command rejects missing or duplicate identities. It does not fall back to unsigned or ad-hoc signing.
Only `SCT_SIGN=adhoc` selects ad-hoc signing. See [CI release builds](#ci-release-builds).

## Build and sign

Run from the repository root:

```sh
bun run package:mac
```

The command compiles the application, packages its generated files, and signs the app and nested Electron binaries.
The command also copies the `@napi-rs/keyring` native module into the app. The `.node` binary stays outside the asar archive, and the command signs it with the app.
It copies the AirDrop helper (`out/airdrop`) to `Contents/Resources` and signs it with the app.
It selects the certificate by its fingerprint after checking its name and code-signing validity.
This code-signing check replaces the signing library's general certificate lookup, which rejects certificates trusted only for code signing.
The command then checks the complete signature and the expected bundle identifier and certificate.
No private key enters the build directory or application bundle.

On Apple Silicon, the output is `dist/global.sct-darwin-arm64/global.sct.app`.
On Intel Macs, the output is `dist/global.sct-darwin-x64/global.sct.app`.
The application window uses `global.sct`. The filename is `global.sct.app` so Finder displays the application normally.
Git ignores `dist/` and `out/`.

macOS may request permission for `codesign` to use the private key.
Approve that request through macOS. Do not enter your Keychain password into a project file or command argument.

Open the signed app on Apple Silicon:

```sh
open dist/global.sct-darwin-arm64/global.sct.app
```

Use the `global.sct-darwin-x64` directory on an Intel Mac.
Run `bun run install:cli` to install the `sct` command. See [CLI and SDK setup](runtime-injection.md).
`bun run dev` and `bun start` use the development Electron runner. They create no signed app.

## Check a rebuild

1. Run `bun run package:mac`.
2. Record the certificate fingerprint from its output.
3. Run `bun run package:mac` again.
4. Check that both builds pass the signature check.
5. Check that both builds report the same fingerprint.

For an additional inspection on Apple Silicon:

```sh
codesign --verify --deep --strict --verbose=2 dist/global.sct-darwin-arm64/global.sct.app
codesign --display --verbose=4 dist/global.sct-darwin-arm64/global.sct.app
codesign --display --requirements - dist/global.sct-darwin-arm64/global.sct.app
```

The identifier must be `app.global-sct.desktop`. The authority must be `global.sct Development`.
The designated requirement must remain the same after a rebuild.

## App icon

`build/icon.svg` is the icon source. Its colors copy the renderer role tokens. Its font is Martian Mono.
After you change the SVG, run `bun run build:icon` from the repository root. Then commit `build/icon.svg` and `build/icon.icns`.
The command renders the SVG in Electron, because `sips` cannot render OKLCH colors or variable font axes.
Then it makes the icon sizes with `sips` and the `.icns` file with `iconutil`.

## CI release builds

The Release workflow (`.github/workflows/release.yml`) runs on each push to `main`. It does not wait for the Checks workflow.
It runs `bun run package:mac` with `SCT_SIGN=adhoc`, because the CI runner has no `global.sct Development` identity.
It puts `global.sct.app` and an Applications link into `global.sct-macos-arm64.dmg`.
Then it replaces the `latest` prerelease and its tag with a new prerelease for the pushed commit.
A newer push stops an older run.

An ad-hoc signature has no certificate. Thus the identity changes with each build, and the certificate check does not apply.
macOS Keychain can ask again for access to stored secrets after you install a new build.
The build has no notarization. Gatekeeper blocks the first start of a downloaded copy. See the README for the steps.
Use the local identity for development builds.

## Scope

This identity signs local development builds. It provides no Apple trust for public distribution and no notarization.
Hardened Runtime stays on. The build grants `com.apple.security.cs.disable-library-validation`, because the local certificate has no Apple Team ID.
Without it, macOS rejects the Electron framework when the app starts. The entitlement also permits other libraries without a matching Team ID. Thus use this configuration for development only.
The build also grants `com.apple.security.cs.allow-jit`.
CI checks the app without a signing key.

See [Apple's certificate instructions](https://support.apple.com/guide/keychain-access/create-self-signed-certificates-kyca8916/mac)
and [Electron's signing guide](https://www.electronjs.org/docs/latest/tutorial/code-signing).
