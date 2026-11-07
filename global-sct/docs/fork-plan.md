# Fork plan and change assessment

## Purpose

This document records the proposals from the Gemini conversation about .sct.
It compares each proposal with the current code.
Use the decision table before you start any work.
The user delegated the remaining technical choices on 2026-11-04.
The [remaining feature plan](remaining-features-plan.md) records those choices. Implementation and new tests remain separate work.

## Source

The source is `geminichat.pdf` in the repository root.
Git ignores this file.
The file is a print of a Gemini chat named "Cross-Platform Secret Storage Solutions".
The chat has 12 pages and 10 user prompts.

## Status labels

| Label | Meaning |
|---|---|
| Add | The code does not do this. It needs design and approval. |
| Keep | The code does this and it works. Do not change it. |
| Change | The code does this, but the proposal needs a different implementation. |
| Drop | Do not do this. The cost is too high, or the design forbids it. |
| Build on | Use the idea as the base of a smaller change. |

## Proposals that are correct

| Proposal | Evidence in this repository |
|---|---|
| Secrets never enter the project folder. | `sct run` builds the child environment in [`launch.ts`](../src/main/launch.ts). |
| Each secret value has its own Keychain key. | [`vault.ts`](../src/main/vault.ts) creates one key for each value, and one file key for each project. |
| A project read starts one Keychain read for each value. | `withProjectSecrets` starts all reads together with `Promise.allSettled`. |
| The caller check uses macOS tools. | [`caller.ts`](../src/main/caller.ts) runs `/bin/ps` and `/usr/bin/codesign`. |
| The build and the CLI install are macOS-only. | [`install-cli.ts`](../scripts/install-cli.ts) writes a POSIX script to `~/.local/bin`. The package path contains `global.sct-darwin-${process.arch}`. |
| AirDrop is macOS-only. | `native/airdrop.swift` compiles with `swiftc` in the `build:airdrop` script. |
| The relay is a central service. | `packages/relay` and [`relay-connection.ts`](../src/main/relay-connection.ts) use SpacetimeDB Maincloud. |
| Agent approval opens a local window. | [`mcp.ts`](../src/main/mcp.ts) and [`agent-access.ts`](../src/main/agent-access.ts) use the approval window. |
| The project has 10 agent skills. | `skills/` holds 10 folders. |

## Proposals that are wrong

These statements in the chat do not match the code.
Correct the record before you plan work.

1. **"`seal.ts` talks to the macOS Keychain to wrap the keys."**
   [`seal.ts`](../src/main/seal.ts) holds AES-256-GCM helpers only.
   It imports `node:crypto` and nothing else.

2. **"The vault uses the macOS `security` CLI."**
   No code calls `security`.
   `vault.ts`, `sharing.ts`, and `relay-connection.ts` use `AsyncEntry` from `@napi-rs/keyring`.
   That package uses Windows Credential Manager, Linux libsecret, or macOS Keychain.

3. **"`packages/env/src/protocol.ts` defines a Unix socket path."**
   That file defines one JSON line format.
   It has no path, no socket, and no network code.

4. **"The SDK connects to the app over a local socket."**
   `loadEnv` starts `sct _env` and reads its standard output.
   `streamEnvironment` writes to a private pipe.
   The code creates no socket, pipe file, or FIFO.
   The Windows named pipe change has no target.

5. **"`safeStorage` is a drop-in replacement."**
   `safeStorage` exists only in the Electron main process.
   The CLI and the MCP server also read keys.
   A change to `safeStorage` needs a separate key path for those processes.

6. **"A master key removes the signing setup."**
   The Keychain prompt depends on the code signature of the binary that reads the item.
   A master key does not remove this requirement.

## Decision table

| ID | Change | Current state | Recommendation | Cost | Risk |
|---|---|---|---|---|---|
| C1 | Universal vault unlock with envelope encryption | One Keychain key for each value and one file key | Change. Direction approved | High | Vault migration, unlock design, macOS test coverage |
| C2 | Electron `safeStorage` instead of `@napi-rs/keyring` | `@napi-rs/keyring` in the app, the CLI, and the relay | Drop | Low | Breaks key reads outside Electron, with no Windows gain |
| C3 | A local endpoint for the editor | No socket. Standard input and output only | Decide with D14 | Low | A socket or a named pipe is a new attack surface |
| C4 | Cross-platform caller check | `/bin/ps` and `/usr/bin/codesign` | Add, only with a Windows or Linux build | Medium | A weaker identity check on Windows and Linux |
| C5 | Guard AirDrop to macOS | `swiftc` runs on every build | Add | Low | None |
| C6 | Windows CLI shim | POSIX script in `~/.local/bin` | Add with C7 | Low | None |
| C7 | Windows and Linux builds | macOS DMG only | Add, signed from the repository | High | Signing credentials, new install paths, new UI tests |
| C8a | Hyperswarm transport | SpacetimeDB relay | Add | High | NAT failures, both peers online, new dependency |
| C8b | WebRTC transport | SpacetimeDB relay | Add | High | Needs signalling, both peers online, renderer only |
| C8c | sct link transport | None | Add. Q7 is closed: use the current X25519 envelope, not `age` | Medium | One-way, manual receipt link |
| C8d | Shared receipt contract for every transport | Relay receipt only | Add with C8a to C8c | Medium | A receipt needs a return path |
| C10 | Encrypted vault in GitHub Variables | None | Drop | Low | Adds a GitHub account and a token to the local path |
| C11 | VS Code extension | Electron window | Build on, as a client of the app | High | Two approval paths and two vault paths |
| C12 | VS Code terminal injection | `sct run` | Build on after C11 | Medium | Secrets in every terminal of the window |
| C13 | Keep the relay as the optional mailbox | Relay works | Keep | None | It stays a third-party service and a SpacetimeDB build step |
| C14 | Remove `docs/macos-signing.md` | The file is required | Keep | None | Keychain prompts return |
| C15 | Process-group signals for `sct run` | `launch.ts` uses `process.kill(-pid)` and `/bin/ps` | Add with C7 | Medium | A Windows job object is a different mechanism |
| C16 | User gate on app and agent shares | None | Add. Vault passphrase only. No reveal feature | Medium | A gate cannot protect a compromised machine |
| C17 | Keep Wallet cards on macOS only | Cards and AirDrop are macOS only | Keep, and hide the view on other systems | Low | Two UI paths |
| C18 | New color theme | Current Terminal theme | Add later | Low | Needs a full token pass and screenshots |

## Delivery modes

The sender selects one mode for each transfer.

| Mode | Path | Peer offline | Receipt |
|---|---|---|---|
| Direct | Hyperswarm or WebRTC | No | Same session |
| Mailbox | The current relay | Yes | On pickup |
| Link | Paste `global-sct://import/...` | Yes, by hand | Manual `global-sct://receipt/...` |

Rules:

- Direct is the default when the peer is online.
- The mailbox is the default when the peer is offline and the user permits a server copy.
- Link is always available.
- Every mode uses the same envelope and the same receipt contract (C8d).

### Why the mailbox stays

The relay module holds 372 lines. The generated client holds 553 lines.
The desktop relay connection holds 1544 lines.
Most of that code is pairing, delivery status, receipts, expiry, and remote tasks.
A smaller mailbox replaces the storage, not that code.
The saving is small. The rewrite is large.

Revisit a smaller mailbox only for one of these reasons:

1. You want to remove the SpacetimeDB toolchain.
2. You want to self-host the mailbox.
3. Maincloud pauses or costs too much.

## Application identity

The repository name does not set the application identity.
These values do:

| Value | Current | Where |
|---|---|---|
| Package name | `global.sct` | `package.json` |
| Runtime application name, and the `userData` folder | `global.sct` | `app.setName('global.sct')` in `src/main/index.ts` |
| macOS bundle ID | `app.global-sct.desktop` | `scripts/package-macos.ts` |
| Transfer type ID | `app.global-sct.desktop.transfer` | `scripts/package-macos.ts` |
| Local signing identity | `global.sct Development` | `scripts/package-macos.ts` |
| OS master-key service | `global.sct` | `createSecretStore` in `src/main/index.ts` |
| Vault folder | `~/global.sct` | `Vault` default root |
| CLI command | `sct` | `scripts/install-cli.ts` |
| SDK package | `@sct/env` | `packages/env/package.json` |
| MCP server name | `global.sct` | `src/main/mcp.ts` |
| Link scheme | `global-sct://` | Pairing, transfer, receipt, and MCP resource encoders |

The fork now uses a separate identity. This replaces the earlier D5 and D19 decisions to retain the upstream identity.
Use the [explicit migration](fork-storage-migration.md) to preserve an existing vault and its project records.

## Recorded decisions

| Date | Decision | Effect |
|---|---|---|
| 2026-11-03 | Support Windows and Linux | C4, C6, C7, and C15 enter scope |
| 2026-11-03 | Add a VS Code extension that connects to the app | C11 and C12 enter scope. The extension is a client. It does not replace the app window |
| 2026-11-03 | Use signed builds from the repository | C7 needs signing credentials and a signing step for each platform |
| 2026-11-03 | Move off the macOS Keychain to a universal unlock, with envelope encryption | C1 enters scope. The key store becomes one interface with one option for each platform |
| 2026-11-03 | Share peer-to-peer by default, and keep the relay as an optional mailbox | C8a to C8d enter scope. C13 is a keep. This entry replaces the earlier "no relay" entry |
| 2026-11-03 | Offer all three send modes at send time | Direct, mailbox, and link. The mailbox uses the current relay. A smaller mailbox is deferred |
| 2026-11-03 | Keep SpacetimeDB as the mailbox, and do not self-host | C13 and D10 are keeps. D18 keeps the database |
| 2026-11-04 | Store the vault with one `scrypt` key, unlocked by a passphrase | D1, D2, D3, D4, and D16 are closed. The vault needs a new format |
| 2026-11-04 | Break the current file formats | No migration code. Old vault and transfer files are ignored |
| 2026-11-03 | Provide all three transports | C8a, C8b, and C8c enter scope. Every transport needs a receipt |
| 2026-11-03 | Add a user gate to sharing | C16 enters scope |
| 2026-11-04 | Use a standalone fork | D17 is closed. The release target is this repository |
| 2026-11-04 | Use versioned Git tags and unsigned beta releases until signing is available | D13 is closed. D12 is deferred |
| 2026-11-04 | Close Q7, D6, D7, D8, D14, D15, and the C12 form | The link uses the current envelope. The transport order is Link, Hyperswarm, WebRTC. The extension uses the CLI only. The theme has two variants. See [docs/implementation-plan.md](implementation-plan.md#7-cross-phase-decision-summary) |
| 2026-11-04 | Theme setting: Light (Cream), Dark (Terminal), or System. Cream is the default | Q12 is closed. The setting is an Appearance section on the Storage page. AGENTS.md lists both variants |
| 2026-11-04 | Cream uses the colors of the user's reference screenshot, with a dark forest green accent | Q13 is closed. Both variants use the same selected-tab style. See [docs/theme.md](theme.md) |
| 2026-11-04 | Add `sct run --interactive` for shells | Q11 is closed. The VS Code terminal uses `sct run --interactive -- <shell>` |
| 2026-11-04 | Delegate the remaining technical choices | The remaining feature specification closes protocol choices P1–P6, D11, Q9, and Q10. It selects transport limits, receipt recovery, and the TURN credential exception. Implementation remains separate |
| 2026-11-03 | Keep Wallet cards on macOS only | C17 enters scope |
| 2026-11-03 | Change the color theme later | C18 enters scope, after the other work |
| 2026-11-03 | Initially retain the upstream identity | Superseded by the standalone identity decision below |
| 2026-11-04 | Name the standalone fork `global.sct` | Separate vault, app records, OS credential service, and application identifier. Use `global-sct://` links. Keep the `sct` CLI and `@sct/env`. Move existing storage explicitly |

## Open decisions

| ID | Decision | Options | Blocks | Note |
|---|---|---|---|---|
| D1 | How a user unlocks the vault | Decided: passphrase, plus "remember this device" | Phase 0 | The OS store is optional, so Linux with no secret service still works |
| D2 | The scope of one master key | Decided: one key for the vault | Phase 0 | One unlock opens every project |
| D3 | The key derivation function | Decided: `scrypt` from `node:crypto` | Phase 0 | No new dependency |
| D4 | The existing vaults | Decided: clean break | Phase 0 | Old vault files are not read. Users re-enter secrets |
| D5 | The application identity | Decided: `app.global-sct.desktop`, separate app records and credential service | Phase 0 | The user selected standalone fork identity. Existing storage moves explicitly |
| D6 | The order of the transports | Decided: Link, then Hyperswarm, then WebRTC | Phase 2 | The link transport has no network dependency. It tests the receipt contract first |
| D7 | The WebRTC signalling path | Decided: manual token exchange with signed and sealed `global-sct://connect` links | Phase 2 | It adds no server. The signature binds the DTLS fingerprint to the verified peer |
| D8 | Pairing without the relay | Decided: the device card as an `global-sct://pair/v1/<card>` link or a file, with the current pairing code | Phase 2 | It uses `previewPeer`, `confirmPeer`, and `pairingCode`. It works on all platforms |
| D9 | The receipt when the peer is offline | Decided: the mailbox returns the receipt on pickup | Phase 2 | The direct and link modes use C8d |
| D10 | The relay code | Decided: keep it | Phase 2 | It is the mailbox implementation |
| D11 | The gate factors | Decided: vault passphrase only | Phase 4 | Reuses the existing verifier across platforms |
| D12 | The signing credentials | Decided: deferred. Unsigned beta releases until signing is available | Phase 1 | No certificate means no signed build |
| D13 | The CI runners and the release channel | Decided: three runners. Versioned beta tags until signing | Phase 1 | The old workflow replaced `latest` on each push |
| D14 | The VS Code extension scope and link | Decided: CLI only (`sct agent` and `sct run`) | Phase 3 | It adds no socket or pipe (C3). It uses the current caller check and approval window |
| D15 | The color theme | Decided: two variants of the Terminal theme, Terminal (dark) and Cream (light). AGENTS.md changes to allow them | Before the new sharing UI | Each new screen gets one check in both variants |
| D16 | Backward compatibility | Decided: break the format | Phase 0 | The new build reads no old vault or transfer file |
| D17 | The release target | Decided: a standalone fork | Phase 1 | The release target is this repository |
| D18 | The SpacetimeDB database | Decided: keep it | Phase 2 | Maincloud holds the current relay data |
| D19 | The product names | Decided: `global.sct` app and MCP server. Keep `sct` CLI and `@sct/env` | Phase 1 | One selected `sct` command per PATH |

D6, D7, and D11 are implemented as of 2026-11-05.
The [implementation plan](implementation-plan.md#status-2026-11-05) records the Windows results and the open platform checks.

## Effects of the clean break

1. The new build reads no file from the current vault.
2. The new build reads no current transfer file.
3. The demo data does not move to the new format.
4. The current Keychain items stay on the Mac until the user deletes them. The new build does not read them.
5. Users add their secrets again after the first unlock.

## Sequence if you approve

Do not start a phase before you approve its items.

**Phase 0: storage**

1. Write the vault format for one master key and one key for each value.
2. Write the passphrase unlock with `scrypt`, and the "remember this device" wrapper.
3. Write one key store interface with a fake store for tests.
4. Time `sct run -- true` with 10 secrets and with 40 secrets.
5. Confirm that the build reads no old vault file and no old transfer file.

**Phase 1: portability**

1. C17: hide Wallet cards and AirDrop on other systems.
2. C4: add the caller check for Linux and Windows.
3. C6: write the Windows CLI shim.
4. C7: add the Windows and Linux builds.

**Phase 2: sharing**

1. C8d: define the receipt contract.
2. C8c: add the sct link transport. It needs no server.
3. C8a: add the Hyperswarm transport.
4. C8b: add the WebRTC transport.
5. C13: keep the relay as the optional mailbox (D10, D18, and Q8).

**Phase 3: editor client**

1. C11: start the VS Code client.
2. C12: add terminal injection after C11.

**Phase 4: access and looks**

1. C16: add the user gate.
2. C18: the Cream variant moves before the new sharing UI (D15). The final screenshot pass stays here.

## Constraints

- Keep the project folder free of `.env` files and secret files.
- Keep local Agent Access free of relay dependencies.
- Never give a secret value to an agent.
- Use TypeScript only, and no `any` type.
- Add no test without approval.

## Checks

Run these commands after a code change:

```sh
bun typecheck
bun run check
bun run build:sdk
```

Run `bun run react-doctor` after a UI change.
Run the Playwright tests after a UI change.
