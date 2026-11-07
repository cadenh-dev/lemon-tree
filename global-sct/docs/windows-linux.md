# Windows and Linux

global.sct runs on Windows and Linux. The macOS-only features stay on macOS.

## What differs by platform

| Feature | macOS | Windows | Linux |
|---|---|---|---|
| Vault and secrets | Yes | Yes | Yes |
| `sct run` and `sct _env` | Yes | Yes | Yes |
| Agent Access | Yes | Yes | Yes |
| Device pairing by link or file | Yes | Yes | Yes |
| Direct sharing | Yes | Yes | Yes |
| WebRTC sharing | Yes | Yes | Yes |
| Link sharing | Yes | Yes | Yes |
| Relay sharing | Yes | Yes | Yes, with libsecret |
| AirDrop sharing | Yes | No | No |
| Wallet cards | Yes | No | No |
| Caller signature check | Apple code signature | Authenticode signer | No code signature. The caller is unverified |

On Windows and Linux, the app hides the **Cards** link, the AirDrop controls, and the **Send secrets** and **Receive secrets** tabs. Use **Verify devices** to pair devices without the relay. Use the **Send** tab to choose Direct, WebRTC, Link, or Mailbox.
Direct needs outbound UDP. Both apps must be open and unlocked. The Windows and Linux packages include the Hyperswarm native modules.
WebRTC uses manual offer and answer links. It needs no inbound port and no signalling server. A public STUN server is optional. A TURN server can forward traffic when a direct path is blocked.
Every send asks for the vault passphrase. The share gate is the same on all platforms.

## Requirements

- Bun 1.4.4 or later.
- Node.js 22.18 or later.
- Windows: PowerShell 5.1 or later. The caller check uses `Get-CimInstance` and `Get-AuthenticodeSignature`.
- Linux: a `/proc` file system. The caller check reads `/proc/<pid>/stat` and `/proc/<pid>/exe`.
- macOS only: the Xcode command line tools. The AirDrop helper uses `swiftc`.

## Build

Run these commands from the repository root.

```sh
bun install
bun run package:win    # Windows
bun run package:linux  # Linux
```

The output is in `dist/`:

- Windows: `dist/global.sct-win32-<arch>/sct.exe`
- Linux: `dist/global.sct-linux-<arch>/sct`

The build installs the production dependency closure, including the `@napi-rs/keyring` and Hyperswarm native modules for the host platform.
The build does not run `swiftc` on Windows or Linux.
The build does not sign the package. See [Signing](#signing).

A tag such as `v0.1.0-beta.1` builds all three platforms and publishes a GitHub prerelease with `SHA256SUMS.txt`.
Stable tags are rejected until signing is available. See [Windows and Linux signing](windows-linux-signing.md).

## Install the CLI

```sh
bun run install:cli
```

- Windows: the command writes `%LOCALAPPDATA%\Programs\global.sct\bin\sct.cmd`.
- Linux: the command writes `~/.local/bin/sct`.

Add the folder to `PATH`, then open a new terminal.
A terminal can start `sct.cmd`. A direct MCP client cannot start a `.cmd` file. Use the full `sct.exe` path, or `cmd /c sct mcp`.
The installer also writes `sct.json`. The `@sct/env` SDK reads it to start `sct.exe` without a shell. Set `SCT_CLI` to use another executable path.

Check the command. It returns the bundled skill list and exits:

```sh
sct skills
```

## Open links from other apps

Use the packaged app. Open **Storage**, find **Links**, and select **Register global.sct links**.

- Windows writes per-user registry values under `HKCU\Software\Classes\global-sct`. It needs no administrator rights. Moving the portable folder requires registration again.
- Linux writes `app.global-sct.desktop` under `$XDG_DATA_HOME/applications`, or `~/.local/share/applications`, and calls `xdg-mime`. A desktop session with `xdg-mime` is required.
- macOS uses the `CFBundleURLTypes` entry in the packaged `global.sct.app`.

If another app owns the scheme, select **Replace handler** in the app.
The development build uses paste. It does not change the operating-system handler.

## Signing

The Windows and Linux packages are unsigned beta builds. Releases use versioned tags such as `v0.1.0-beta.1`.
D13 is closed: three runners and versioned tags. D12 is deferred: no paid signing for now.
Do not publish an unsigned package as a signed build.
See [Windows and Linux signing](windows-linux-signing.md) for the signing path and the current release steps.

The Windows caller check requires a valid Authenticode signature and the matching publisher and product metadata.
Claude Code requires an `Anthropic` signer and `Claude Code` in the file metadata.
Visual Studio Code (`Code.exe`) requires a `Microsoft Corporation` signer and `Visual Studio Code` in the file metadata.
A listed caller that fails its signature check cannot request local approval.
Verify the metadata with the real Claude Code build before release. A certificate thumbprint pin is a follow-up.

## Limits

- Windows does not use process groups. `sct run` stops the child tree with `taskkill /T /F /PID`. It cannot always let the child exit cleanly after Ctrl+C.
- Linux has no code signature. A process name match gives an unverified caller. The app asks for the extra confirmation.
- The relay keeps its per-server cache keys in the OS secret store. A Linux system with no secret service cannot use the relay mailbox until these keys move. See [Relay cache keys](storage-design.md#7-decisions-and-remaining-questions).
- Linux needs `libsecret` for "Remember this device" and the relay cache keys. The passphrase path works without it.
- The Linux package uses the native packages that Bun selects for the host platform. Treat a musl build as unverified until its package loads the keyring and Hyperswarm native modules.
- On Windows, file access uses the folder ACL. Keep the vault in a folder that only your account can access.
- A direct MCP client cannot start `sct.cmd`. Use `cmd /c sct mcp` or the full `sct.exe` path.
- The existing Playwright suite now unlocks the vault, but it still uses macOS and POSIX assumptions. `tests/platform.spec.ts` is the Windows smoke test.
- WebRTC with TURN, public STUN, and cross-network paths is not verified on this Windows host. The direct no-server path is verified between two app instances.
- The share gate waits for the vault passphrase. An automated UI test must enter the passphrase or cancel the dialog.
- The Windows `tests/app.spec.ts` secret test still reaches an interactive `cmd.exe` step, and `tests/sharing.spec.ts` still expects the disabled **Send secrets** tab. These are test-platform issues, not product failures. See [the remaining plan](remaining-features-plan.md#windows-ui-test-findings-2026-11-04).

## Checks

Run these commands after a code change:

```sh
bun run typecheck
bun run typecheck:tsc
bun run check
bun run build:sdk
bun run react-doctor
bun run test
bun run test:ui
```

The Windows and Linux package jobs run on their own check runners. They build unsigned packages only.
The Playwright tests need a graphical session. The Windows smoke test runs on the Windows check runner.

### Linux arm64 result (2026-11-05)

The Oracle server ran Ubuntu 24.04 on ARM64 with Bun 1.4.4 and Node 22.18.0.

- `bun run check` and `bun run typecheck:tsc` passed.
- `bun run test` passed all 42 tests.
- `bun run react-doctor` returned 100/100.
- `bun run package:linux` produced `dist/global.sct-linux-arm64`.
- The packaged CLI printed `0.1.0` under Xvfb.
- The theme UI test passed under Xvfb.
- The signal test found a real bug: the launcher returned `128 + signal` even when the child handled the signal and exited with its own code. Commit `55b99f5` fixes this. The test now passes on Linux.

The portable Linux package needs this step before it starts:

```sh
sudo chown root:root chrome-sandbox
sudo chmod 4755 chrome-sandbox
```

Without that step, Electron stops with a sandbox helper error when unprivileged user namespaces are disabled. Do not use `--no-sandbox` for a release check. CachyOS had unprivileged user namespaces enabled, so it did not need the setuid step.

The server is ARM64. The Linux x64/glibc target is checked separately on CachyOS.

### Linux x64 result (CachyOS, 2026-11-05)

CachyOS x64 is an Arch-based glibc Linux system.

- `bun run package:linux` produced `dist/global.sct-linux-x64`.
- The packaged app started under Wayland with unprivileged user namespaces. The setuid sandbox step was not needed on this system.
- The CachyOS app paired with the Windows x64 app through the device cards.
- The Hyperswarm Direct peer came online.
- Windows sent one synthetic secret. CachyOS imported it into its test project and returned the signed receipt.
- The Windows app showed `received`.
- The temporary two-machine test passed in 1.6 minutes. The test files were removed.

The direct WebRTC offer and answer did not connect on that network without STUN or TURN. The local TURN-only check passed on Windows. Public STUN, remote TURN, and cross-network WebRTC remain open.

The full x64 suite also passed on CachyOS:

- `bun run check` passed with no errors or warnings.
- `bun run typecheck:tsc` passed.
- `bun run test` passed all 42 tests in 15.15 seconds.
- `bun run react-doctor` returned 100/100.

The Linux x64 release target now has package, unit suite, and Direct P2P evidence.

Two `app.spec.ts` checks do not pass on the headless ARM64 server:

- The first test expects the Electron `sandboxed` metric. Linux does not report that field.
- The second test exceeds the default 30-second timeout.

These are test-platform issues. They do not show a product failure. Do not change the tests without approval.

### Windows result (2026-11-05)

- `bun run check`, `bun run typecheck:tsc`, `bun run test`, and `bun run build` passed. The unit suite had 39 passes and 3 skips.
- React Doctor returned 100/100.
- `bun run package:win` passed. The packaged CLI printed `0.1.0`.
- `platform.spec.ts` passed. `theme.spec.ts` passed.
- `app.spec.ts` passed its project test. Its secrets test timed out at 30 seconds at the known CLI step.
- `sharing.spec.ts` still expects the macOS-only disabled **Send secrets** tab on Windows. It is not run here.
- A temporary two-window Playwright check passed. It paired two vaults, rejected a wrong passphrase, accepted the correct passphrase, cancelled a share, and completed a 60,000-character WebRTC transfer with an import and receipt. The check file was not committed.
- A temporary two-window Playwright check passed against the live Maincloud relay. The apps connected, registered, paired relay devices, queued a Mailbox transfer, imported it, and returned the signed receipt. The check file was not committed.
- A temporary two-window WebRTC check passed through a local TURN-only server. The connection showed **Direct via TURN** and completed a transfer and receipt. Public STUN and a remote TURN server are not run.
- The Windows package includes Hyperswarm and Sodium. The `.node` files are in `app.asar.unpacked`.
- macOS, public STUN, remote TURN, and cross-network WebRTC checks are open.
The existing suite now unlocks the vault, but it still uses macOS and POSIX assumptions. It needs platform gating before it can run on all platforms.
