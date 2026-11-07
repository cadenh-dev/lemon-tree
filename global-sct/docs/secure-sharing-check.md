# Secure sharing check

This record closes the Phase 2 sharing checkpoint in issue #20.
The check date was 2026-10-24.

## Two-Mac result

The project owner used two real Mac desktop apps.
The owner confirmed that the apps showed a verified recipient and completed secret sharing.

The check used the app UI. It did not use the global.sct CLI, MCP, an agent, or an approval flow.

## Security evidence

The existing test suite supplied the repeatable security checks:

- A recipient decrypted the transfer and returned a correlated signed receipt.
- A third identity could not decrypt another recipient's payload or receipt.
- Wrong keys, forged senders, changed routing fields, changed ciphertext, and changed signatures failed.
- Expired delivery and access deadlines failed.
- Duplicate delivery returned the saved receipt and did not import the secret again.
- Restart recovery kept the original destination and did not duplicate an import.
- Offline vault operations used encrypted files and the vault master key.
- Expired grant cleanup removed the vault entry.

The full suite passed 38 tests.

An isolated Maincloud database supplied the relay authorization checks.
Anonymous SQL reads failed for the private `device`, `message`, `delivery`, and `receipt` tables.
An anonymous subscription to the private `message` table also failed.

The relay derives each sender from the connection identity.
The `acknowledge` reducer selects a delivery with the message ID and caller identity.
The pair reducers permit status changes only for the pair members.
The client views filter rows with the caller identity.

The envelope and vault tests searched stored bytes and renderer data for test values.
They found no plaintext secret or private key in those outputs.

## Windows check (2026-11-05)

The project owner ran a temporary two-window Playwright check on Windows x64.
The check file was deleted after the run, because new tests need approval.

The check did these steps:

1. It paired two independent vaults with the device-card link and the pairing code.
2. It created a Link with a wrong passphrase, then with the correct passphrase.
3. It cancelled a second Link share and confirmed that no link was created.
4. It connected two apps with a WebRTC offer link and answer link.
5. It sent a 60,000-character secret over the WebRTC data channel.
6. The recipient imported the secret and returned the signed receipt.
7. The sender showed the transfer as `received`.

The check did not test TURN, public STUN, macOS, or Linux.

## Live Mailbox check (2026-11-05)

A second temporary two-window Playwright check used the live Maincloud relay on Windows x64.
The check file was deleted after the run.

The check did these steps:

1. Both app instances connected to Maincloud and registered their device keys.
2. The devices paired in the **Relay** tab. Both users compared the same code.
3. The sender selected **Mailbox** in the **Send** tab and permitted the encrypted server copy.
4. The sender entered the vault passphrase in the share dialog.
5. The recipient imported the transfer and the app returned the signed receipt.
6. The sender showed the transfer as `received`.
7. The recipient vault contained the imported secret name.

The live relay password, token, and secret value did not appear in the UI or test output.

## TURN-only check (2026-11-05)

A local `node-turn` server supplied a TURN-only path on Windows x64.
The server used `127.0.0.1:3478` with a synthetic username and password.
The check file and the temporary server folder were removed after the run.

The check did these steps:

1. Both apps saved the TURN URL and credentials in the WebRTC network settings.
2. Both apps selected **Use TURN only**.
3. The apps exchanged one offer link and one answer link.
4. The connection reported **Direct via TURN**.
5. A secret crossed the TURN-only data channel, the recipient imported it, and the sender received the signed receipt.

This proves the TURN configuration, credential storage, relay policy, route label, and data path.
It does not prove public STUN, a remote TURN server, or a cross-network path.
Those checks need separate network conditions.

## Linux arm64 check (2026-11-05)

An Oracle server ran Ubuntu 24.04 on ARM64.
The server had Bun 1.4.4, Node 22.18.0, and Xvfb.

- `bun run check`, `bun run typecheck:tsc`, and `bun run react-doctor` passed. React Doctor returned 100/100.
- `bun run test` passed all 42 tests.
- `bun run package:linux` produced `dist/global.sct-linux-arm64`.
- The packaged CLI printed `0.1.0` under Xvfb.
- The theme UI test passed under Xvfb.
- The Linux signal test found a real bug. The launcher returned 130 instead of the child exit code 37. Commit `55b99f5` fixes the POSIX signal result.

The CachyOS x64 run covers the Linux x64 package, the full unit suite, and Direct P2P below.
The portable package needs `chrome-sandbox` owned by root with mode 4755 when unprivileged user namespaces are disabled. CachyOS had them enabled, so it did not need the setuid step.

## CachyOS x64 Direct P2P (2026-11-05)

The CachyOS x64 unit suite passed:

- `bun run check`: no errors or warnings.
- `bun run typecheck:tsc`: no errors.
- `bun run test`: 42 passed, 0 failed, in 15.15 seconds.
- `bun run react-doctor`: 100/100.

A CachyOS x64 app and the Windows x64 app completed a Hyperswarm Direct transfer.
The two apps paired through the device-card link and compared the same code.
The Windows app found the CachyOS peer online.
Windows sent one synthetic secret.
CachyOS imported it into its test project and returned the signed receipt.
Windows showed `received`.
The temporary test passed in 1.6 minutes.

A direct WebRTC offer and answer did not connect on that network without STUN or TURN.
The TURN-only path passed with a local TURN server on Windows.
Public STUN, remote TURN, and cross-network WebRTC remain open.

## VS Code host check (2026-11-05)

The Windows host has VS Code 1.143.1.
The extension requires VS Code `^1.145.0`.
The development host does not load the extension.
The extension build passes.
Update VS Code to 1.145 or later before the live extension check.

## Application checks

- `bun run test`: 39 passed, 3 skipped.
- `bun run check`, `bun run typecheck:tsc`, and `bun run build`: passed.
- Electron Playwright: the temporary two-window WebRTC and share-gate check passed.
- React Doctor: 100/100.
- The existing Windows UI suite keeps two test-platform failures. See [Windows and Linux](windows-linux.md#limits).

The local full build reached the native AirDrop helper.
That helper did not compile because the installed Swift compiler and macOS SDK versions differ.
The TypeScript, SDK, main, preload, renderer, demo, and Electron test builds passed.

## Expiry limits

- A delivery deadline must be in the next seven days.
- Relay maintenance runs each minute.
- The relay retains delivery records for 30 days after the delivery deadline.
- The relay retains encrypted expiry notices for 30 days.
- The sender selects the local access deadline.
- The app checks local access at import and before each use.
- The app runs local cleanup at startup, each minute, and after system resume.
- A WebRTC offer or answer link expires after five minutes.
- A WebRTC connection starts within 30 seconds after the answer.
- A share confirmation expires after two minutes.
- The gate releases one operation and is not saved.

