# global.sct

global.sct is a desktop app for macOS, Windows, and Linux. It keeps project secrets out of project folders.
Your project needs no `.env` file.

Existing installations: follow the [storage migration guide](docs/fork-storage-migration.md) before starting the fork.

- **Vault.** global.sct keeps secrets in an encrypted local vault. A passphrase derives one master key, and each value has its own data key. The OS secret store is optional.
- **Runtime injection.** `sct run -- <command>` gives the command its secrets as environment variables.
- **SDK.** The dependency-free `@sct/env` package loads secrets into `process.env` and applies saved changes without a restart.
- **Sharing.** global.sct sends encrypted secrets to a verified device by Direct connection, by link, through AirDrop on macOS, or through a relay.
- **Agent Access.** Coding agents use secrets through a CLI and an MCP server. Each request opens a local approval window. Agents never receive secret values.


This project is a fork of [omavashia2005/.sct](https://github.com/omavashia2005/.sct).

## Download

Releases use versioned Git tags such as `v0.1.0-beta.1`. They are unsigned beta builds until signing is available.
Each release has a macOS DMG, a Windows ZIP, a Linux archive, and `SHA256SUMS.txt` on the [releases page](https://github.com/cadenh-dev/global.sct/releases).
The macOS app has an ad-hoc signature and no notarization. Thus macOS blocks the first start.
Copy `global.sct.app` to Applications. Then right-click the app and select **Open**, or run:

```sh
xattr -dr com.apple.quarantine /Applications/global.sct.app
```

On Windows, unzip the package and run `sct.exe`. If SmartScreen blocks it, select **More info**, then **Run anyway**.
On Linux, extract the archive and run `sct`.

## Quick setup

Use macOS, Windows, or Linux, Bun 1.4.4 or later, and Node.js 22.18 or later. On macOS, also install the Xcode command line tools.

```sh
git clone https://github.com/cadenh-dev/global.sct.git
cd global.sct
bun install
bun run dev
```

`bun run dev` opens the app. It needs no relay, cloud credentials, or environment variables.

To get the `sct` command, build the app for your platform. On macOS, first do the one-time Keychain setup in [macOS signing](docs/macos-signing.md).

```sh
bun run package:mac    # macOS
bun run package:win    # Windows
bun run package:linux  # Linux
bun run install:cli    # Installs the sct command
```

Create a vault passphrase at the first start. Then add a project folder and its secrets. Run the project from its folder:

```sh
sct run -- bun run dev
```

To load secrets in code, build the SDK and add it to your application. The SDK is not on npm yet.

```sh
bun run build:sdk
bun add /absolute/path/to/global.sct/packages/env   # Run this command in your application folder.
```

Load the secrets before the application imports:

```ts
import { loadEnv } from '@sct/env'

await loadEnv()
await import('./server.js')
```

See the [SDK guide](packages/env/README.md).

## Share through the relay

The relay lets two devices share secrets when they are not near each other.
The app connects to the hosted relay (SpacetimeDB Maincloud, database `sct-relay`) when it starts.
You need no account, login, or configuration. The relay stores ciphertext and routing metadata only.

This check is optional. It requires the [SpacetimeDB CLI](docs/relay.md#install-the-cli). To check that a device can reach the relay, run:

```sh
spacetime describe sct-relay --server maincloud --anonymous
```

Pair the two devices one time. On both devices, open **Sharing**, then the **Relay** tab.

1. On device B, copy the ID under **This device’s relay ID**. Send it to device A by any channel.
2. On device A, enter the relay ID and select **Request pairing**.
3. Both devices show a pairing code. Compare the two codes in person or on a call.
4. If the codes are the same, select **I compared this code on both devices** and **Confirm relay device** on each device.
   If the codes are different, select **Remove**.

To send secrets:

1. On the sending device, select a project, the paired recipient, and the secrets.
2. Optionally, set **Access expires**.
3. Select **Queue encrypted transfer**. The recipient device does not need to be online.

To receive secrets, open **Received transfers** on the recipient device. Select a local project and **Import and send receipt**.

AirDrop pairing and relay pairing are separate. A device that you verified through AirDrop must also pair on the **Relay** tab.
To use your own relay, see [relay setup](docs/relay.md).

## Agent setup prompt

Paste this prompt into your coding agent:

```text
Set up global.sct on this computer. Follow these steps in sequence:

1. Clone https://github.com/cadenh-dev/global.sct.git and open the cloned folder.
2. Read AGENTS.md and README.md.
3. Run `bun install`.
4. On macOS, run `security find-identity -v -p codesigning`.
   If the output does not show exactly one valid "global.sct Development" identity, stop.
   Tell me to follow docs/macos-signing.md. Do not create, export, or change certificates.
   On Windows or Linux, skip this step.
5. Run the package command for this platform, then run `bun run install:cli`.
   macOS: `bun run package:mac`. Windows: `bun run package:win`. Linux: `bun run package:linux`.
6. Add the MCP server "sct" with the command `sct` and the argument `mcp`.
   On Windows, use `cmd /c sct mcp` or the full `sct.exe` path because a direct MCP client cannot start a `.cmd` file.
7. Open the app from dist/. Tell me to choose a vault location outside every project folder.

Rules:
- Never read, print, or write a secret value.
- Never create a .env file or another secret file.
- Each global.sct request opens an approval window. Wait for my decision. Do not retry a refused or expired request without my instruction.
```

## Known limitations

- The Windows and Linux packages are unsigned. Signing waits on D12 and D13.
- The Windows caller check uses the Authenticode signer and product metadata. It does not pin a certificate thumbprint yet.
- A direct MCP client cannot start `sct.cmd`. Use `cmd /c sct mcp` or the full `sct.exe` path.
- A Linux system without `libsecret` cannot use the relay mailbox. The relay cache keys stay in the OS secret store.
- The existing Playwright suite now unlocks the vault, but it still uses macOS and POSIX assumptions. `tests/platform.spec.ts` is the Windows smoke test.

## Docs

- [Runtime injection](docs/runtime-injection.md) and the [`@sct/env` SDK](packages/env/README.md)
- [Sharing](docs/sharing.md) and [relay setup](docs/relay.md)
- [Windows and Linux](docs/windows-linux.md) and [Windows/Linux signing](docs/windows-linux-signing.md)
- [Agent Access](docs/agent-access.md) and the [Claude Code demo project](examples/claude-code/README.md)
- [Architecture](docs/architecture.md), [vault storage](docs/storage.md), and the [glossary](docs/glossary.md)
- [Fork plan and change assessment](docs/fork-plan.md)

Contributors and agents follow [AGENTS.md](AGENTS.md).
