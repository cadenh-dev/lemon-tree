# Windows and Linux signing

This document is a draft for Phase 1 task 1.9.
It has no credentials and changes no code.
D17 is closed: this is a standalone fork. D13 is closed: three runners and versioned tags.
D12 is deferred: unsigned beta releases until signing is available.

For an open-source standalone fork, paid signing is optional.
The low-cost path is unsigned Windows and Linux packages with SHA-256 checksums, plus clear documentation.
macOS is the exception. An ad-hoc build still triggers Gatekeeper, and Keychain access can prompt again after a rebuild.
Do not publish an unsigned package as a signed build.

## Current beta release

- The release workflow runs on tags such as `v0.1.0-beta.1`.
- It rejects a tag that does not end with `-beta.<number>`.
- It builds macOS, Windows, and Linux artifacts.
- It creates `SHA256SUMS.txt`.
- It publishes a GitHub prerelease. Stable tags wait on signing.

Create a beta release with:

```sh
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

## Current state

- The Windows and Linux package scripts do not sign.
- The macOS build keeps its local identity and notarization path. See [macOS signing](macos-signing.md).
- The Windows caller check expects a valid Authenticode signature from an `Anthropic` signer with `Claude Code` metadata.
- For Visual Studio Code (`Code.exe`), the Windows caller check expects a valid Authenticode signature from `Microsoft Corporation` with `Visual Studio Code` metadata.

## Windows options

### Option A: Azure Trusted Signing

The plan recommends this option.
It costs less than an EV certificate and needs no hardware token in CI.

Prerequisites:

1. An Azure subscription.
2. A Trusted Signing account and a Public Trust certificate profile.
3. A service principal for CI. Give it the Trusted Signing Certificate Profile Signer role.
4. These CI secrets:

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | The Entra tenant ID |
| `AZURE_CLIENT_ID` | The service principal application ID |
| `AZURE_CLIENT_SECRET` | The service principal secret, or use OIDC |
| `AZURE_CODE_SIGNING_ENDPOINT` | The Trusted Signing endpoint |
| `AZURE_CODE_SIGNING_ACCOUNT` | The Trusted Signing account name |
| `AZURE_CERTIFICATE_PROFILE` | The certificate profile name |

Signing step:

1. Install the Trusted Signing client tools on the Windows runner.
2. Sign `dist/global.sct-win32-<arch>/sct.exe` with `signtool` and the Trusted Signing dlib.
3. Use a timestamp server.
4. Sign the Electron helper executables and DLLs that the package contains, or state which files stay unsigned.
5. Verify the result:

```powershell
$signature = Get-AuthenticodeSignature -LiteralPath dist\global.sct-win32-x64\sct.exe
if ($signature.Status -ne 'Valid') { throw "The Windows signature is not valid." }
```

Do not put the service principal secret in the repository or in a package.

### Option B: Traditional code-signing certificate

Use an OV or EV certificate from a public CA.

1. Import the certificate into the Windows runner certificate store, or read a PFX from a CI secret.
2. Sign the main executable:

```powershell
signtool sign /sha1 <thumbprint> /tr <timestamp-url> /td sha256 dist\global.sct-win32-x64\sct.exe
```

3. Verify with `Get-AuthenticodeSignature`.
4. Remove the certificate from the runner after the job.

An EV certificate can need a hardware token. A hosted signing service is simpler for CI.

## Linux

Linux has no common code-signing requirement for a downloaded executable.
Use these checks:

1. Publish a SHA-256 checksum for each artifact:

```sh
sha256sum dist/global.sct-linux-x64/sct > dist/global.sct-linux-x64/sct.sha256
```

2. Optionally sign the checksum with a release GPG key.
3. Publish the checksum and the signature next to the package.
4. State the libc variant in the artifact name or the release notes (`gnu` or `musl`).

## Release rules

- Read credentials only from CI secrets.
- Put no credential in the repository.
- Keep the macOS signing behavior unchanged until D12 is closed.
- Do not replace a stable release with an unsigned build.
- Publish unsigned builds only as prereleases with `SHA256SUMS.txt`.
- Record the certificate or key fingerprint in the release notes after signing starts.

## Checklist for tasks 1.9 and 1.10

1. Close D12.
2. Close D13.
3. Close D17.
4. Add the signing secrets to the repository settings.
5. Add the signing step to the Windows package job.
6. Add the checksum step to the Linux package job.
7. Add Windows and Linux runners for checks and releases.
8. Verify each artifact before upload.
9. Publish versioned releases, not one moving `latest` tag.
