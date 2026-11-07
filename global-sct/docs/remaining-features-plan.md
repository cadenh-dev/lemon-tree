# Remaining feature plan

Date: 2026-11-04. Status: technical decisions complete for the remaining scope.

This document expands tasks 2.5–2.11 and 4.1–4.4 from the [implementation plan](implementation-plan.md).
It also records the remaining platform and editor checks.
The user delegated the remaining technical choices. This document records those choices.
The request covers planning only. It authorizes no implementation, dependency installation, protocol registration, or new tests.
Earlier closed decisions remain in force, except for the explicit WebRTC credential exception below.

## Starting point

- Shared delivery types exist in `src/shared/transport.ts`.
- `src/main/transport.ts` maps relay receipt states. It does not yet define a common transport interface.
- Link encoding and validation exist in `src/main/transport-link.ts`.
- `Sharing` supports Link creation, preview, import, and receipt verification.
- Pairing without the relay exists. Direct transports must use those verified peers.
- Cream and Terminal already exist. New screens use the current role tokens.
- The VS Code extension and its guide exist. Live editor verification remains open.

The handoff reports a successful Windows package build. That report does not establish macOS or Linux verification.

## Delivery sequence

1. Complete protocol handling with its import and receipt UI (2.5 and the Link part of 2.10).
2. Add Hyperswarm with usable send, receive, and receipt screens (2.6 and parts of 2.9–2.10).
3. Add WebRTC with connection exchange and the same delivery screens (2.7 and parts of 2.9–2.10).
4. Complete the Mailbox adapter and the common selector (2.8–2.10).
5. Add the approved share gate to every outgoing path (4.1–4.4).
6. Complete documentation, platform verification, and the applicable #33 integration checks (2.11).

Each transport includes enough UI for a two-window check when its delivery code becomes available.
The final selector depends on both Direct transports and the Mailbox adapter.
The receipt display can start with Link and Mailbox before Direct exists.
Local Agent Access and the editor remain independent of the relay.
Keep GitHub issue IDs and the [architecture prerequisites](architecture.md#implementation-order) unchanged.

## 2.5: Open sct links

Outcome: an external link opens the appropriate app flow without importing secrets automatically.

Implementation steps:

1. Add one main-process dispatcher for pairing, import, and receipt links.
2. Reserve the connect route for 2.7. Until then, return an unsupported-operation message.
3. Apply length and schema checks before decoding or routing a link.
4. Reuse the existing pairing and envelope validators.
5. Handle initial launch arguments and subsequent link events.
6. Preserve CLI launches, including `run`, `_env`, `agent`, and `mcp`.
7. Wait for the app window and vault unlock before presenting the link.
8. Show sender metadata and destination selection before import confirmation.
9. Match receipt links to a saved outgoing transfer. Verify the receipt before updating its state.
10. Add registration support to the platform packaging or installation path selected below.

Electron uses `open-url` on macOS and `second-instance` for Windows and Linux link delivery.
Registration and packaged behavior need separate platform checks. See the [Electron deep-link guide](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app).

Selected decisions:

| ID | Choice | Decision |
|---|---|---|
| P1 | Registration | Provide an explicit registration action for packaged apps. Do not register from ordinary development launches. |
| P2 | Existing handler | Preserve another handler. Explain the conflict and require an explicit replacement action. |
| P3 | Pending links | Hold one active link in memory. If another arrives, ask which link to keep. |
| P4 | macOS development | Use a packaged development app for external-link checks. Keep paste support for routine development. |
| P5 | Receipt selection | Select the matching transfer from authenticated receipt data. Show its metadata before applying the receipt. |
| P6 | Pending-link persistence | Do not save unopened links. Closing the app discards them. Keep existing saved transfer and receipt records. |

Expected files: `src/main/index.ts`, a focused protocol module, shared IPC types, preload, sharing UI, and `scripts/package-*.ts`.

Acceptance: cold and warm launches work. Locked launches resume after unlock.
Invalid, oversized, unknown, and expired links produce a clear result without import.
A repeated import does not create another secret. An unrelated receipt cannot change a transfer.
Two independent vaults remain usable for delivery checks. Desktop instance handling does not intercept CLI commands.
Use the registration and removal procedures in the detailed specification below.

## 2.6: Hyperswarm Direct delivery

Outcome: two verified peers exchange an encrypted transfer and a verified receipt without the Mailbox service.

Keep the approved topic derivation, daily rotation, unlocked-only announcement, and ten-minute receipt session.
Topic discovery does not replace envelope signature verification.

Implementation steps:

1. Pin Hyperswarm 4.17.2. Check its packaged Electron runtime behavior on all three platforms.
2. Define the minimum common adapter operations required by Link and Hyperswarm.
3. Keep shared mode, transport, and delivery types in `src/shared/transport.ts`.
4. Start discovery for verified peers when the vault unlocks. Stop discovery and sessions when the vault locks or exits.
5. Implement bounded framing for encrypted transfers and receipts using the existing envelope size constraints.
6. Verify the sender and recipient before offering an import.
7. Reuse durable import and duplicate detection. Save the receipt before sending it.
8. Preserve an unsent receipt for the next session or manual receipt exchange.
9. Expose connection and delivery metadata to the UI.
10. Package native dependencies for each supported platform.

Use a 30-second connection deadline and zero automatic transfer retries.
On failure, show “Peer not reachable” and offer Link or an authorized Mailbox transfer.
Do not silently upload a failed Direct transfer to Mailbox.
These limits define product behavior. They do not guarantee connectivity on every network.

Use the [Hyperswarm API documentation](https://github.com/holepunchto/hyperswarm) to check discovery and shutdown behavior before implementation.
Use only the current UTC day's topic. Rotate discovery at midnight without closing authenticated sessions.
On resume, recalculate the day before joining discovery. Do not search adjacent days.
If clocks differ across midnight, explain that both devices need the correct time. Offer manual WebRTC or Link.

Expected files: new `src/main/transport-hyperswarm.ts`, sharing service, shared types, package files, and packaging scripts.

Acceptance: two peers complete a transfer and receipt. A duplicate transfer does not import again.
Disconnect, lock, restart, receipt timeout, and unreachable-peer checks produce the approved states.
Direct delivery works with relay configuration absent. Packaged binaries load their native dependencies on each platform.

## 2.7: WebRTC Direct delivery

Outcome: verified peers establish a Direct session through manual connection-link exchange.

Keep signed and sealed `global-sct://connect` links, no STUN by default, optional public STUN, and user-supplied TURN.
Store TURN credentials in the vault's `.internal/` folder.

Implementation steps:

1. Implement the hidden-window boundary and narrow TURN exception specified below.
2. Define versioned offer and answer schemas, session correlation, expiry, and fingerprint verification.
3. Keep signing, decryption, peer verification, and receipt verification in the main process.
4. Add the hidden entry point and a narrow preload bridge.
5. Validate the calling window and allowed message types for each IPC operation.
6. Add offer creation, answer creation, and answer acceptance to the visible app flow.
7. Carry the existing encrypted envelope and receipt through the data channel.
8. Close the session and hidden window on cancellation, vault lock, or app exit.

The window uses sandboxing, context isolation, no Node integration, and no remote page navigation.
These controls follow the [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

The hidden window receives ciphertext, SDP, session controls, ICE server addresses, and the selected TURN credentials.
This is a deliberate exception to the earlier ciphertext-and-SDP-only plan.
TURN needs these credentials to establish the configured connection.
Destroy the window and its nonpersistent partition when the session ends. Never log its configuration.
Never send vault keys or shared secret values to this window.

Use the expiry, chunk, and connection-link limits below.
An oversized connection link fails with an explanation and offers Hyperswarm or Mailbox. There is no signalling server or file fallback.

Expected files: `src/main/transport-webrtc.ts`, hidden renderer and preload entries, shared types, protocol dispatcher, and `electron.vite.config.ts`.

Acceptance: offer and answer exchange establishes a session between verified peers.
Wrong peers, changed fingerprints, expired offers, and unrelated answers fail validation.
Import and receipt behavior match Hyperswarm. Cancellation leaves no active window or connection.
Check no-STUN, permitted-STUN, and configured-TURN cases separately on real networks.

## 2.8–2.10: Mailbox, mode selection, and receipts

Outcome: users select an available mode and see the same delivery meaning in each mode.

Implementation steps:

1. Adapt the existing relay service to the common transport operations.
2. Preserve relay wire formats, identity pins, expiry behavior, and existing saved records.
3. Keep Link and Direct independent of relay imports and initialization.
4. Add the final selector using actual connection availability and explicit permission for a server copy.
5. Keep Link available. Explain its size limit before the user creates an oversized transfer.
6. Show receipt status as each transport becomes usable.
7. Keep delivery receipts separate from remote task approval and execution results.

Use the existing activity list, with a plain status label and an applicable action on each row.
Use “Waiting for receipt”, “Received”, “Return receipt manually”, “Expired”, and “Failed”.
Show the peer, mode, and time using existing metadata. Do not add a separate status dashboard.
“Received” means a verified receipt confirms durable import. Sending bytes does not establish receipt.
An expired transfer has no confirmed receipt. The label must not claim that the peer never imported it.

Use Hyperswarm as the normal Direct path and WebRTC as an explicit connection option.
An authenticated, open session establishes Direct availability. Discovery announcements alone do not establish availability.
Preserve the approved online/offline defaults. Never infer permission for a server copy from a failed connection.
For peers paired only outside the relay, explain that Mailbox needs its own verified relay pairing.

Keep Cream as the default. Use the existing Terminal tokens, Martian Mono, square surfaces, and immediate keyboard focus.
Check both variants, keyboard operation, errors, and reduced motion for each UI increment.

Acceptance: each available mode completes a two-window transfer with the correct receipt state.
Saved records retain their states after restart. Relay outages do not block local Agent Access, Link, or Direct.

## 4.1–4.4: Confirm each share

Outcome: each outgoing share requires the approved confirmation factor in the main process.

D11: use the vault passphrase. Do not add WebAuthn in this task.
Q10: cover shares only, including agent requests. Do not add a reveal or copy-value feature.

Implementation steps:

1. Identify all outgoing paths: Link creation, Direct sends, Mailbox sends, agent shares, and macOS AirDrop.
2. Show the recipient, project, secret names, and delivery mode in the confirmation dialog.
3. Check the passphrase through the existing vault verifier.
4. Bind the confirmation to the pending operation in the main process.
5. Execute only that operation after successful verification.
6. Clear the pending confirmation on cancellation or vault lock.
7. Route agent requests through the app dialog. Never ask an agent to supply the passphrase.

A renderer boolean must not authorize later arbitrary sends.
Return verification status to the dialog while the main process retains control of the approved operation.
Use one confirmation per outgoing operation, with all recipients visible, and a new confirmation for a user-requested resend.
Receipt acknowledgments do not send new secrets. Exclude them from the share gate.

Expected files: vault verifier or focused gate module, sharing service, agent access, IPC and preload, and a shared dialog.

Acceptance: wrong or cancelled confirmation sends nothing. A successful confirmation cannot authorize a different recipient or secret selection.
An unlocked vault still requires the share confirmation. Each approved outgoing path enforces the same rule.

## Completion checks and deferred work

Use Bun 1.4.4 or later. Run `bun run check`, `bun run typecheck:tsc`, and `bun run build:sdk` for implementation changes.
Run the existing relevant tests from their configured test directory.
Do not add or change tests without approval. Record uncovered cases for manual checks or a later approved test change.
For every UI change, run `bun run react-doctor` and the applicable existing Playwright tests. Target a score of 100.

- Investigate the reported Windows `app.spec.ts` timeout before treating the UI suite as a release check.
- Check external links, delivery, receipts, lock, restart, and packaged startup on Windows, Linux, and macOS.
- Use two independent vaults for functional checks and two machines for network checks.
- Check the live VS Code extension, terminal isolation, approval, and locked-vault behavior with the relay off.
- Keep signing deferred under D12. Report unsigned packages accurately.
- Q9: keep remote demo tasks on Mailbox for this scope.
- Update sharing, relay, architecture, platform, and gate documentation as the corresponding features become complete.
- Reconcile theme and caller status with evidence. Do not mark unrun platform checks complete.

The user's delegation permits the technical choices above.
Implementation and new tests remain separate work. Missing machines or credentials are verification dependencies, not unresolved design choices.

### Windows UI test findings (2026-11-04)

The Windows UI run has 3 passes and 2 failures. Both failures are test-platform issues:

- `tests/app.spec.ts`, "manages secrets per project without rendering stored values": `application.process().spawnfile` is `cmd.exe` on Windows. The test starts `cmd.exe` and waits at an interactive prompt. Use the Electron executable path for the CLI checks, or skip the POSIX CLI and SDK steps on Windows. The product CLI is not proven defective.
- `tests/sharing.spec.ts`, "shares selected secrets into the recipient project...": the test expects a disabled **Send secrets** tab. Windows intentionally hides that tab because AirDrop is macOS-only. Add a `darwin` guard, or gate the AirDrop assertions.

These test updates need approval. Do not change the product to satisfy them.

## Detailed implementation specification

This section selects application limits. These limits do not describe library defaults.

### Protocol registration and routing

Add `src/main/protocol.ts` for routing and `src/main/protocol-registration.ts` for operating-system integration.
Add **Storage > Links** with registration status, **Register sct links**, and **Remove registration**.
Registration is per user. It needs no administrator privileges.
Registration failures leave paste-based flows available and show the operating-system error without the incoming URL.

Windows:

1. Use the packaged executable's absolute path with `app.setAsDefaultProtocolClient('global-sct')`.
2. Inspect the effective handler with `getApplicationInfoForProtocol('global-sct://')`. Treat an unreadable handler as a conflict.
3. Require **Replace handler** when the handler belongs to another executable.
4. Quote the executable and URL argument separately. Never execute a received URL through a shell.
5. Verify ownership after registration. A successful API return alone is insufficient.
6. Call `removeAsDefaultProtocolClient('global-sct')` only if the registered command still points to this executable.
7. If Windows retains another user-selected default, direct the user to Default apps. Do not modify protected default-association data.

macOS:

1. Add `CFBundleURLTypes` with scheme `global-sct` and the existing bundle identifier during packaging.
2. Require an installed `.app` for external-link checks. Ordinary `bun run dev` uses paste flows.
3. Use the Electron default-protocol API only after the explicit registration action.
4. Detect conflicts using the current handler information. Verify the selected handler after the operation.
5. Call `removeAsDefaultProtocolClient('global-sct')` for an owned association. Explain that this does not remove the bundle's advertised scheme.
6. If the OS cannot clear the association, report that result. Never report successful removal without checking it.

Linux:

1. Write `app.global-sct.desktop` under `$XDG_DATA_HOME/applications`, or `~/.local/share/applications` when unset.
2. Use `Type=Application`, `Name=global.sct`, `Terminal=false`, and `MimeType=x-scheme-handler/global-sct;`.
3. Set `Exec` to the escaped absolute executable path followed by `%u`. Use Desktop Entry escaping. Reject executable paths containing `=`.
4. Mark the file `X-Sct-Managed=true`. Replace it only when that marker and executable ownership match.
5. Query `xdg-mime query default x-scheme-handler/global-sct` before changing the default.
6. Use `xdg-mime default app.global-sct.desktop x-scheme-handler/global-sct` after confirmation.
7. Query again to confirm the result. If `xdg-mime` or a desktop session is absent, show an unsupported-registration result.
8. On removal, delete only the owned desktop entry and its own scheme-association references in user configuration.
9. Preserve other applications and schemes. Report a stale OS association if the desktop environment does not refresh it.

The [xdg-mime documentation](https://portland.freedesktop.org/doc/xdg-mime.html) requires an installed desktop entry and recommends checking the resulting default.
Use the [Desktop Entry rules](https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html) for quoting and percent escapes.
Use the [Electron protocol APIs](https://www.electronjs.org/docs/latest/api/app#appsetasdefaultprotocolclientprotocol-path-args) for Windows and macOS registration.
Moving a portable package requires registration from its new location. Do not add an installer or background repair service.
Keep a nonsecret registration record under userData with the managed executable path. Do not restore an old handler automatically.

Link routing rules:

- Accept only `global-sct://pair/v1/`, `global-sct://import/`, `global-sct://receipt/`, and `global-sct://connect/v1/` with their strict payload schemas.
- Reject query strings, fragments, credentials, ports, extra path segments, and noncanonical base64url payloads.
- Apply the existing pairing limit to pairing links. Apply 16,384 characters to all other links before allocation.
- Register macOS event listeners before app readiness. Inspect startup arguments for Windows and Linux before showing the window.
- Apply desktop single-instance handling per userData directory. Parse and exclude CLI commands before taking the desktop lock.
- Keep one active and one newly offered link in memory. Reject a third distinct link with “Finish the current link first”.
- Ignore a repeated copy of either pending link. Replacing a link needs the user's choice. Nothing imports on arrival.
- Clear pending links on exit. Vault lock keeps the pending ciphertext link, but clears decoded previews.
- Resolve receipt correlation to a saved transfer, then verify the expected peer signature. An unsigned correlation ID never authorizes a state change.

### Shared delivery service and records

Add a main-process delivery service above the existing sharing operations.
Keep public metadata types in `src/shared/transport.ts`. Keep Buffer-based wire types in `src/main/transport.ts`.
Use these adapter operations:

| Operation | Inputs | Result |
|---|---|---|
| `availability` | Verified recipient ID | `ready`, `connecting`, or `unavailable`, with a bounded reason code |
| `send` | Prepared envelope, wrapped recipient key, abort signal | Transfer submitted, or a structured transport failure |
| `sendReceipt` | Verified peer ID and encrypted signed receipt | Submission result |
| `close` | Session ID | Session resources released |

Link adapts submission to link creation and manual receipt exchange. Mailbox adapts submission to its existing publish operation.
The service owns preparation, the share gate, saved records, and receipt verification. Adapters never read secret values.
Use `unknown` at all external boundaries, then schema validation. Do not add `any` or a new schema library.
Retain Zod for the existing Zod-based boundary. Do not introduce Effect solely for this work.

Add versioned Direct records under the existing app-data `sharing` directory:

- `direct-sent.json`: transfer ID, recipient ID, transport, timestamps, project/name metadata, receipt state, and last failure code.
- `direct-outbox/<transferId>.json`: encrypted envelope and wrapped key for an explicit retry of the same transfer.
- `direct-inbox/<transferId>.json`: encrypted envelope, wrapped key, sender ID, destination ID when selected, and import state.
- `direct-receipts/<transferId>.json`: encrypted signed receipt and its original import timestamp.

Use the existing serialized file-write conventions and atomic replacement. Never save decrypted values in these files.
Keep existing Link and relay stores. Build a common activity projection instead of migrating all records.
Use `(mode, transferId, recipientDeviceId)` for activity row identity. Keep the original delivery mode when a receipt returns through another path.

Import lifecycle:

1. Validate the complete transfer. Persist its encrypted inbox record before showing the import preview.
2. Persist the selected destination before calling the existing vault import operation.
3. Use `envelope:<id>:<digest>` for the existing Link/Direct duplicate rule.
4. Extend the import completion metadata to retain `receivedAt` and the imported secret count with the completed import.
5. Generate and atomically save the receipt from that completion metadata before transmitting it.
6. If a restart occurs between import and receipt storage, reconstruct the receipt from the saved completion metadata.
7. A duplicate returns the saved receipt. Reject the same transfer ID with different bytes.

This closes the concrete import-success/receipt-loss gap. It adds completion metadata and a receipt file, not a second transaction engine.
Apply the same receipt recovery path to Link imports so manual receipts remain available after restart.
Keep receipts until explicit history removal. Keep unimported ciphertext only until its delivery deadline.
Delete outgoing ciphertext after verified receipt or expiry. Keep its metadata record.
Do not retransmit a transfer at startup. Reconnect may return saved receipts without sending secret transfers again.
User-selected retry reuses the same ciphertext, ID, digest, and recipient. It requires a new share confirmation.

State rules:

- `pending` follows successful submission. `manual` requires a manual receipt return path.
- `failed` records submission failure. It does not prove that no bytes reached the peer.
- `expired` stops further import or transmission after the deadline, unless the vault already completed that import.
- A valid late receipt can change `failed`, `manual`, or `expired` to `received`.
- `received` never regresses. Receipt validation still checks transfer identity and the expected device.
- Cancellation stops local work. The UI states that cancellation cannot retract a transfer already imported by the peer.

### Direct wire format and session limits

Both Direct transports use the same binary framing. A frame starts with a four-byte unsigned big-endian body length.
The body starts with one kind byte. Unknown kinds and unsupported versions close the session.

| Kind | Body after the kind byte | Maximum size |
|---|---|---|
| 1: hello | Strict UTF-8 JSON authentication message | 4,096 bytes |
| 2: authenticate | Strict UTF-8 JSON signature message | 4,096 bytes |
| 3: transfer | Four-byte envelope length, envelope bytes, wrapped-key bytes | Envelope: 8 MiB. Wrapped key: 4,096 bytes |
| 4: receipt | Existing signed encrypted receipt bytes | 16,384 bytes |
| 5: ping | Eight-byte random nonce | Eight bytes |
| 6: pong | Exact ping nonce | Eight bytes |

The frame-body limit is `1 + 4 + 8 * 1024 * 1024 + 4096` bytes.
Reject zero lengths, incomplete inner lengths, and surplus bytes after structured payloads.
Each connection assembles one frame at a time. Never allocate from an unchecked advertised length.
Allow one active transfer per peer and four active transfers overall. Other send requests wait visibly or can be cancelled.
Allow at most 32 authenticated sessions and eight unauthenticated sockets. Close excess sockets without allocating transfer buffers.
These bounds limit memory use for existing 8 MiB transfers. They do not add bandwidth scheduling or a resumable-transfer protocol.

Selected timing:

- Connection attempt: 30 seconds, including at most five seconds for authentication after socket connection.
- Incomplete-frame inactivity: 30 seconds. Total transmission limit: two minutes per transfer.
- Import and receipt wait: ten minutes after the complete envelope arrives.
- Session ping interval: 15 seconds. A missing pong after 30 seconds closes the session.
- No automatic transfer retransmission. **Retry** starts one new user-requested attempt.
- Default Direct delivery lifetime: 24 hours. Retain the existing seven-day envelope maximum and 60-second clock tolerance.
- Discovery remains active while unlocked. Hyperswarm discovery maintenance is distinct from transfer retries.

Hyperswarm authentication:

1. Exchange strict hello objects: `version: 1`, `deviceId`, and a fresh 32-byte base64url nonce.
2. Require the claimed device in `sharing/peers.json` before continuing.
3. Sort the two device IDs lexically. Associate each nonce and Noise public key with its owning device.
4. Sign the UTF-8 JSON array `["sct-direct-auth-v1", lowId, highId, lowNonce, highNonce, lowNoiseKey, highNoiseKey]` with Ed25519.
5. Exchange `{version: 1, signature}` with a canonical base64 64-byte signature.
6. Verify both peer ownership and the signature using the paired device card. Only then mark the session ready.

Read Noise keys from the established encrypted stream, never from the hello message.
Reject self-connections. For duplicate peer sessions, keep the lexically smallest authentication tuple, including both fresh nonces.
Device authentication prevents a discovered socket from becoming trusted through topic membership alone.
The [Hyperswarm API](https://github.com/holepunchto/hyperswarm) documents topic discovery, encrypted connections, and stream peer keys.

Derive the topic with the existing paired X25519 keys, HKDF-SHA256, salt `sct-direct-topic-v1`, and UTC date `YYYY-MM-DD` as UTF-8 info.
Use 32 output bytes. Destroy discovery on lock and peer removal. Removing a peer also closes its existing sessions.

### Native dependency packaging

Pin `hyperswarm` to `4.17.2`, verified from the [npm package metadata](https://registry.npmjs.org/hyperswarm/4.17.2).
Commit the resolved Bun lockfile during implementation. Do not add a version range.
Keep Hyperswarm external in the main-process bundle.
Replace keyring-only dependency copying with a reusable production-dependency staging step for keyring and Hyperswarm.
Resolve the installed dependency closure, including optional native packages for the current OS and architecture.
Copy package metadata, runtime files, and prebuild directories. Exclude development-only dependencies.
Unpack native `.node` libraries and required native companion files from ASAR.
Use matching platform prebuilds first. If a native module needs rebuilding, use the pinned Electron headers on that platform.
Do not replace a failed native load with a stub or silently omit Direct mode.

Release checks target the existing Windows x64, Linux x64/glibc, and current macOS runner architecture.
Keep existing script support for additional architectures. Treat each additional architecture as unverified until its package passes the same native-load check.
A failed target blocks that target's release. It does not justify changing the transport or Electron version silently.

### WebRTC connection links and boundary

Use one reliable ordered data channel named `sct-direct-v1`. Do not add media tracks or media permissions.
Use one hidden window per active peer session, with a maximum of four WebRTC sessions.
Use a unique partition without a `persist:` prefix. Deny navigation, new windows, downloads, and permission requests.
The hidden preload exposes only session setup, SDP exchange, binary send/receive, status, and close.
Reject IPC from any other window or subframe. The visible renderer receives connection links and metadata only.

SDP contains one application media section, no audio or video sections, and one effective SHA-256 DTLS fingerprint.
Reject conflicting fingerprints and additional media sections. Preserve the exact signed SDP bytes when calling `setRemoteDescription`.
Require an open data channel and a connected peer connection before reporting availability.
The signed offer and answer bind each fingerprint to its verified device. Do not duplicate Hyperswarm authentication on this channel.

The connect link is `global-sct://connect/v1/<base64url UTF-8 JSON>`.
Its strict outer object contains:

`format: "sct-connect"`, `version: 1`, `sessionId`, `senderId`, `recipientId`, `createdAt`, `expiresAt`, `ephemeralKey`, `iv`, `tag`, `ciphertext`, `signature`.

- `sessionId` is a UUIDv4. Device IDs use the existing 64-character lowercase hexadecimal format.
- Timestamps are integer UTC milliseconds. Offers expire after five minutes. Answers reuse the offer's session ID and expiry.
- `ephemeralKey` uses the existing X25519 public-key encoding. IV, tag, ciphertext, and signature use canonical base64.
- IV length is 12 bytes, tag length is 16 bytes, and signature length is 64 bytes.
- Encrypt with AES-256-GCM and a fresh ephemeral X25519 key, using the existing cryptographic helpers.
- Derive 32 bytes with HKDF-SHA256, salt equal to the session ID as UTF-8, and info `sct-connect-v1/<senderId>/<recipientId>`.
- AAD is the UTF-8 JSON array of format, version, session ID, sender, recipient, creation, expiry, ephemeral key, and IV, in that order.
- Sign AAD followed by decoded tag bytes and ciphertext bytes with the existing device Ed25519 key.
- Verify the expected device signature before decrypting. Unknown peers cannot start a connection exchange.

Decrypted offer: `{kind: "offer", sdp}`. Decrypted answer: `{kind: "answer", offerDigest, sdp}`.
`offerDigest` is lowercase SHA-256 of the exact decoded outer offer bytes, including its signature.
Limit SDP to 8,192 UTF-8 bytes. Apply the complete 16,384-character URL limit after encryption and encoding.
Reject an answer without a matching live offer. Accept a single answer per offer.
An identical repeated link focuses the existing flow. Reject a different answer for the same session.
On restart, a connection exchange expires locally. The user creates a new offer.

Gather ICE candidates for at most ten seconds. Copy the link only after gathering completes.
If gathering times out, close the attempt and offer **Retry**. Do not send partial candidates or add trickle signalling.
After applying the answer, use the 30-second connection deadline. No ICE restart runs automatically.
Close on connection failure, expiry before connection, cancellation, lock, or peer removal.
After connection, the five-minute signalling expiry no longer ends the session. The Direct session rules apply.

Send framed bytes in chunks of at most 16 KiB, reduced to the negotiated SCTP maximum when smaller.
Pause when buffered output reaches 256 KiB. Resume below 64 KiB.
Enforce the same frame limits in the main process. The hidden window cannot authorize an import by reporting success.
These choices use the data-channel and ICE configuration APIs in the [WebRTC specification](https://www.w3.org/TR/webrtc/).

ICE configuration:

- Default to `iceServers: []` and policy `all`.
- Public STUN is opt-in. Require the user to enter one `stun:` or `stuns:` server URL. Do not ship a hidden provider default.
- Allow one TURN server with up to two `turn:` or `turns:` URLs, a username, and a password credential.
- Validate URLs as ICE server URLs. Never accept HTTP endpoints or shell commands.
- Store the TURN username and credential together in the encrypted `.internal/` vault area. Keep them outside project injection and sharing selection.
- Pass them only to the selected session window. Clear the visible configuration form after saving.
- Offer **TURN only** with policy `relay`. Otherwise TURN participates with policy `all`.
- Show “Direct via TURN” when the selected connection uses a relay candidate. TURN forwards encrypted traffic but is not durable Mailbox storage.
- Changing configuration affects new sessions. It does not silently restart an active transfer.

### Selector, receipts, and confirmation behavior

The send form contains recipient, selected secret names, mode, delivery deadline, and existing access restrictions.
Direct uses one recipient per transfer. Mailbox retains its existing recipient selection. Link retains one recipient.
Choose an authenticated Hyperswarm session by default. Use an established WebRTC session when Hyperswarm is unavailable.
If both exist, the user can explicitly select WebRTC. Do not race both transports or send duplicate envelopes automatically.
When neither exists, show **Connect directly** outside the mode selector. It starts discovery or the manual WebRTC flow.
Show Direct as a selectable mode only after connection authentication succeeds.
Show Mailbox only with a configured relay, its verified peer mapping, and explicit permission to store an encrypted server copy.
The permission checkbox defaults off for each new operation. If no Direct session exists and permission is on, default to Mailbox.
Otherwise default to Link. An oversized Link disables creation and offers fewer secrets or an explicitly authorized Mailbox operation.

Activity actions:

| State | Sender action | Recipient action |
|---|---|---|
| Connecting | Cancel | No import action yet |
| Waiting for receipt | Paste receipt, or cancel local wait | Review and import pending transfer |
| Return receipt manually | Paste receipt | Copy saved receipt link |
| Received | View metadata | Copy saved receipt link |
| Expired | Create a new transfer | No new import |
| Failed | Retry before expiry, or create a new transfer | Copy receipt if import completed |

A Direct timeout changes the receipt state to `manual` after submission, with “Receipt not confirmed” in the row details.
Manual receipt links accept both Link and Direct records. They retain the original record's mode after verification.
Do not claim AirDrop receipt support. Its existing OS completion behavior remains separate.

Share confirmation expires after two minutes without successful passphrase entry.
The main process retains the selected project, secret IDs, recipient IDs, mode, deadlines, and access restrictions.
Changing any of those fields invalidates the pending confirmation and requires a new one.
Check existence and sharing permission again immediately before sending. A deleted or changed selection returns the user to review.
Serialize one confirmation dialog at a time. New requests wait in the existing approval path and can be cancelled.
Wrong passphrases do not send data. Disable submit during verification. Do not add a permanent lockout policy.
Successful verification authorizes exactly one operation. Consume the authorization before dispatch and never persist it.
No timeout, session reconnection, or renderer callback can create another authorization.
Explicit retries require confirmation. Internal receipt delivery and relay acknowledgment do not.
Creating a Link requires confirmation. Copying an already-created encrypted Link does not create a new share authorization.
AirDrop confirmation precedes package creation and the native picker. It shows the selected secret names and “Recipient selected in AirDrop”.
Agent metadata and local `sct run` keep their existing approval rules. Only agent operations that send secrets enter this gate.
Remote demo tasks and their results remain Mailbox-only under Q9. They retain existing recipient execution approval.

### Verification cases and completion evidence

This request does not authorize new test files. Use existing tests where applicable and record manual checks for uncovered behavior.
Do not silently rewrite an assertion when the planned UI changes its label. Record the exact required test update for separate approval.
The existing Windows smoke test expects “Relay sharing”. Preserve that label until an approved test change accompanies the Mailbox label update.

| Case | Procedure | Required result |
|---|---|---|
| V1 Registration | Register, repeat, conflict with another handler, remove, move portable package | Correct ownership and explicit failures. Other handlers remain intact |
| V2 Routing | Open each route when closed, open, locked, and busy | One correct review flow. No automatic import or lost active selection |
| V3 Invalid input | Wrong scheme/version, changed signature, extra field, oversize, wrong recipient | Rejection before import or state update |
| V4 Pairing | Pair without relay, compare codes, remove peer during connection | Trust requires confirmation. Removal closes the connection |
| V5 Direct delivery | Transfer one secret and a near-limit envelope over each transport | Correct import, one receipt, no plaintext in UI or logs |
| V6 Recovery | Interrupt before import, after import, and before receipt transmission | No duplicate import. Saved completion produces a receipt after restart |
| V7 Failure | Block network, disconnect during transfer, let deadlines expire | Bounded timeout. No server upload or automatic transfer retry |
| V8 Identity | Connect wrong peer, replay authentication, change SDP fingerprint or answer digest | No ready state and no import |
| V9 Networks | Same LAN, separate networks, blocked UDP, STUN enabled, TURN-only | Success where reachable. Accurate failure and route labels otherwise |
| V10 Time | Cross UTC midnight, resume after midnight, offset clocks across date boundary | Correct topic rotation and explicit clock-related recovery guidance |
| V11 Gate | Wrong password, cancel, wait two minutes, modify recipient, retry, agent share | Each outgoing operation requires the matching one-use confirmation |
| V12 Independence | Remove relay configuration and repeat local agent, editor, Link, and Direct flows | Local flows work without relay imports or initialization |
| V13 Appearance | Keyboard-only use in Cream and Terminal, reduced motion, all error states | Immediate focus, correct labels, no token violations |
| V14 Editor | Run extension commands and two terminals in a real workspace | Only the requested terminal gets the selected project environment |
| V15 Integration | Mailbox transfer, remote demo approval, result, and result receipt | Delivery remains distinct from task execution. No Direct task path |

Run V1–V4, V7, V11–V14 on Windows x64, Linux x64/glibc, and the packaged macOS target.
Run V5–V10 on Windows-to-Linux, Linux-to-macOS, and macOS-to-Windows pairs, in both send directions.
Use synthetic secret values and two isolated vaults. Real network checks require two machines.
Run V15 with a configured relay and two completed local Agent Access installations.
Record OS, architecture, app commit, package hash, transport, scenario, and result. Do not put links, SDP, or credentials in evidence logs.

Existing automated coverage includes `envelope.test.ts`, `sharing.test.ts`, `vault.test.ts`, and `runtime.test.ts` through `bun run test`.
Run `bun run check`, `bun run typecheck:tsc`, `bun run build:sdk`, and the platform packaging script.
For UI work, run React Doctor and the applicable Playwright specs from `tests`, using the repository configuration.
Run the full UI script before the final UI completion report. Record failures separately from manual results.
For the Windows timeout, first record the failing assertion, trace, app startup output, and vault state.
Fix product behavior if it is defective. Do not increase the timeout or change tests without approval.

Complete 4.6 with screenshots of new sharing, connection, receipt, registration, and gate states in both themes.
Use synthetic metadata. Preserve existing theme screenshots and identify new evidence by commit.
Mark 4.5 as implemented after checking token use against `docs/theme.md`. Keep new-screen verification open until it runs.
Caller identity remains verified only on platforms with actual verification evidence. Linux callers retain the explicit unverified confirmation.

### Documentation and release boundary

- `docs/sharing.md`: three modes, connection setup, size limits, fallback, manual receipts, and confirmation.
- `docs/relay.md`: Mailbox consent, peer mapping, unchanged wire format, and remote-task restriction.
- `docs/architecture.md`: adapter boundary, receipt recovery, TURN exception, and unchanged issue dependencies.
- `docs/windows-linux.md`: registration, package moves, native dependencies, and platform check results.
- `docs/vscode.md` and `docs/agent-access.md`: live verification results and agent share confirmation.
- `docs/theme.md`: new-screen evidence for both variants.
- `docs/secure-sharing-check.md`: V1–V15 procedures and evidence links.
- `docs/implementation-plan.md` and `docs/fork-plan.md`: resolved decisions and evidence-based status changes.

Signing credentials and notarization remain deferred under D12. Do not request them to complete this scope.
Keep unsigned beta packaging and checksums. Publishing a release is separate from implementing these features.
Do not add reveal, WebAuthn, signalling servers, automatic Mailbox fallback, background daemons, or Direct remote-task execution.
All requested design choices now have a selected behavior. Runtime compatibility and platform success still require implementation evidence.
