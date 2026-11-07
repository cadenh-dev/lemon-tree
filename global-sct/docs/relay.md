# Relay setup

global.sct uses SpacetimeDB Maincloud as the cloud-hosted relay.
The relay stores ciphertext and routing metadata only. See the [architecture](architecture.md#relay-sharing-phase-2).

## Hosted database

| Item | Value |
|---|---|
| Server | Maincloud |
| Endpoint | `https://maincloud.spacetimedb.com` |
| Database | `sct-relay` |
| Module folder | `packages/relay` |
| SpacetimeDB version | 2.13.0 for the CLI and the `spacetimedb` package |

Every connection to the endpoint uses TLS.
Neither demo device runs a local SpacetimeDB server.
On the free plan, Maincloud pauses an inactive database. The next connection starts it again.

## Module layout

`packages/relay/src/index.ts` contains the TypeScript module. Issue #11 adds the tables, reducers, and views.

`packages/relay/package.json` contains no dependencies.
The SpacetimeDB CLI requires this file to detect a TypeScript module.
The `spacetimedb` package is in the root `package.json`, so `bun install` from the repository root installs it.

`packages/relay/tsconfig.json` contains the compiler options that SpacetimeDB requires.
`bun run typecheck` and `bun run typecheck:tsc` check the module.

## Install the CLI

1. Install the CLI:

   ```sh
   curl -sSf https://install.spacetimedb.com | sh
   ```

2. Add `~/.local/bin` to your `PATH` if the `spacetime` command is not available.
3. Use the same version as the `spacetimedb` package:

   ```sh
   spacetime version install 2.13.0
   spacetime version use 2.13.0
   ```

## Deploy the module

1. Log in to Maincloud. A browser window opens for the GitHub or Google sign-in:

   ```sh
   spacetime login
   ```

2. Install the dependencies from the repository root:

   ```sh
   bun install
   ```

3. Publish the module from the repository root:

   ```sh
   spacetime publish sct-relay --module-path packages/relay --server maincloud
   ```

Use the same command to publish an update.
Do not use `--delete-data` unless you intend to delete all relay data.

The build prints `tsc not found in node_modules`.
Ignore this warning. `packages/relay` has no `node_modules` folder, and the repository type checks replace this check.

## Deployment credentials

`spacetime login` saves the login token in `~/.config/spacetime/cli.toml`.
This token can publish and delete the database.

- Do not put this token in Git, in desktop builds, or in CI.
- Only the database owner publishes the module.
- CI checks the module types but does not publish.

## Check each demo device

Run this command on each demo device:

```sh
spacetime describe sct-relay --server maincloud --anonymous
```

The command connects to the endpoint over TLS with a temporary anonymous identity.
It shows the module schema when the device can reach the relay.
It does not use the deployment login and does not send secrets or private keys.

## Client identities

Each demo device uses its own relay identity.
When the app connects for the first time without a token, SpacetimeDB creates an identity and returns a token.
The app keeps this token in the vault under `.internal/` and uses it again for later connections.

The app never uses the deployment login.
Device private keys and secret values never go to the relay.

## App connection

The desktop app connects to the relay when it starts. A command-line process does not connect. The exceptions are approved `relay_status` and `request_remote_demo` requests.
An agent session uses a passive relay. It reads the relay rows and the local files again for each state. It publishes nothing, acknowledges nothing, and writes no relay file except a task request.

- The vault holds the relay token in `.internal/` under `relay/token/<server hash>`.
- After each connection, the app registers the public keys of its AirDrop device card with `registerDevice`.
  The same device keys serve AirDrop and the relay.
- The app subscribes to `my_inbox`, `my_sent`, and `my_peers`.
- After a lost connection, the client reconnects, restores the subscriptions, and registers the device again. A relay data reset deletes the device rows.
  If the client stops, the app makes a new connection after 1 s, then up to 30 s between attempts.
- The app saves the view rows in `relay/cache-<server hash>.sct` in the app data folder.
  The app encrypts the file with AES-256-GCM. The key is in `.sct-relay` under `cache/<server>/<database>`.
  Each relay server has its own files, so a test relay cannot replace the files of the live relay.
  Received ciphertext and delivery status stay available after a restart without the relay.
- The app saves queued transfers in `relay/outbox-<server hash>.sct` and imported transfers in `relay/received-<server hash>.sct`.
  These files use the same encryption. Their keys are in `.sct-relay` under `outbox/<server>/<database>` and `received/<server>/<database>`.
  The app retains a sent record for 30 days after its last delivery or access deadline.
  It retains a received record until cleanup can queue its expiry notice, then for the applicable 30-day period.
- The app saves queued expiry notices in `relay/notices-<server hash>.sct`.
  The Keychain account is `notices/<server>/<database>`.
- The outbox also holds queued remote tasks and their results. The relay stores them in the same tables as transfers.
- The app saves received tasks and their execution records in `relay/tasks-<server hash>.sct`.
  It saves results of the tasks that it sent in `relay/results-<server hash>.sct`.
  The Keychain accounts are `tasks/<server>/<database>` and `results/<server>/<database>`.
  The app retains these records for 30 days after their delivery deadline. It keeps an unreviewed uncertain run until the user reviews it.
- An agent session writes each remote task request to `relay/requests-<server hash>/<task ID>.sct`.
  The Keychain account is `requests/<server>/<database>`. The authenticated data contains the task ID.
  The desktop app watches this folder, sends each request, and deletes its file. A request that fails stays and shows its error.
- Local vault operations do not depend on the relay.

The renderer reads the relay state with `getRelayState` and `onRelayChanged`.
The state contains the connection status, the device identity, and metadata only.
It never contains payloads, wrapped keys, public keys, or the relay token.

The `SCT_RELAY` environment variable selects the relay:

| Value | Relay |
|---|---|
| Not set | Maincloud, `sct-relay` |
| `off` | No relay connection. The UI tests use this value. |
| `<server URL>/<database>` | Another relay, for example `http://127.0.0.1:3000/sct-relay-test` |

## Mailbox consent

The **Send** tab calls this mode Mailbox. The **Relay** tab configures it and shows its activity.
Mailbox stores one encrypted server copy until the recipient imports it.
The **Send** tab shows Mailbox only when all of these conditions are true:

- The relay is configured and registered.
- At least one relay device is verified.
- You select **Allow an encrypted copy on the Mailbox server for this send**.

The permission checkbox starts off for each new operation.
global.sct never selects Mailbox because a Direct connection failed.
A device that you paired through Link, Direct, or AirDrop needs a separate relay pairing.
Mailbox never stores secret values, private keys, or plaintext metadata.
The share dialog shows the recipient, project, secret names, and the Mailbox mode before you enter the passphrase.
The main process holds the operation. A changed window cannot select another recipient or secret set.

Remote demo tasks stay on Mailbox.
A task does not use Direct, WebRTC, or Link.
The recipient still approves each task on its own device.

## Pairing

Two devices must pair before they share secrets. Pairing uses the same device keys as AirDrop.
A device verified through AirDrop still needs a relay pairing, and the reverse is also true.

Do these steps on the **Relay** tab of **Sharing**:

1. Device B shows its relay ID under **This device’s relay ID**: 64 hexadecimal characters. The user sends it to device A by any channel.
2. Device A enters the relay ID and selects **Request pairing**. The app calls `requestPair`.
3. Both apps show the pending pair and the same pairing code.
   The code comes from both relay identities and both device public keys.
4. The users compare the codes, for example in person or on a call.
   Device B shows the code for a pending request even when it saved the keys of device A before.
   For example, this can occur after a relay data reset.
5. If the codes are the same, each user selects **I compared this code on both devices**, then **Confirm relay device**.
   Each app saves the public keys of the other device.
   The app of device B also calls `confirmPair`. On the relay, only the device that did not send the request can accept the pair.
6. If the codes are different, a user selects **Remove**. The app calls `removePair` and deletes its saved keys of that device.

The app saves the accepted keys in `relay/peers-<server hash>.sct`.
The app encrypts this file with AES-256-GCM. The key is in `.sct-relay` under `peers/<server>/<database>`.
If the app cannot read the file, every peer needs a new code comparison.

Each peer in `getRelayState` has a trust state:

| State | Meaning |
|---|---|
| `unverified` | The users did not compare the code. |
| `verified` | The saved keys match the keys on the relay. |
| `changed` | The keys on the relay differ from the saved keys. The users must compare the new code. |
| `invalid` | The keys on the relay are not X25519 and Ed25519 public keys. |

Before a device sends a secret, the relay pair must be `Verified` and the peer trust state must be `verified`.
The recipient applies the same rule to the sender before it opens a transfer.

The **Send** tab uses the same verified relay peers as the **Relay** tab.
The share confirmation is the same for Mailbox, Link, Direct, WebRTC, and AirDrop.
The **Relay** tab uses the preload operations `requestRelayPair`, `confirmRelayPair`, and `removeRelayPair`.
`confirmRelayPair` takes the code on the screen. It fails if the current code is different, for example after a key change.

## Relay delivery

On the **Relay** tab, the sender selects a source project, a verified relay recipient, and secrets.
As an option, the sender sets **Access expires**.
The **Allow command injection only** option is on by default.
Then the sender selects **Queue encrypted transfer** and enters the vault passphrase.
The **Send** tab offers the same Mailbox operation with the other delivery modes.
The main process reads the selected values and creates one signed encrypted transfer.
The main process sets the delivery deadline to 7 days minus 1 minute after the queue time.
The 1-minute margin lets the relay accept a sender clock that is slightly ahead of the relay clock.
It saves the ciphertext in an encrypted local outbox before publication.
When the app has a relay connection, it publishes the transfer immediately. Otherwise, it publishes after the next connection.

The relay checks the authenticated sender, verified pair, stable message ID, and delivery deadline.
The delivery deadline must be in the next 7 days.
A retry with the same ID must contain the same ciphertext, recipient, deadline, and wrapped key.
The relay rejects the ID when any of those fields differ.
After a failed publication or acknowledgment, the app tries again after 1 s, then up to 30 s between attempts.
The app does not publish a transfer after its delivery deadline.
The app uses the original transfer ID for each retry.

The relay runs scheduled maintenance each minute. It uses relay server time.
It deletes a pending delivery after its delivery deadline.
It keeps messages, received delivery records, and encrypted receipts for 30 days after the delivery deadline.
It then removes these records.

**Delivery activity** shows each sent transfer with one of these states:

| State | Meaning |
|---|---|
| `queued` | The transfer is in the local outbox. The relay does not have it yet. |
| `sent` | The relay has the transfer. The recipient did not acknowledge it yet. |
| `received` | The recipient acknowledged the transfer, and the sender verified the receipt. |
| `failed` | The publication or the receipt check failed. The row shows the error. |
| `expired` | The delivery deadline passed before the relay accepted the transfer. |

The recipient main process verifies and decrypts a pending transfer.
The renderer receives the project name, secret names, deadlines, and grant restrictions.
It never receives secret values or private keys.
Under **Received transfers**, the recipient selects a local destination project and selects **Import and send receipt**.

global.sct saves the imported values under local vault protection.
It saves the access deadline and the injection-only restriction with each imported secret.
An injection-only secret can enter an approved process environment, but global.sct cannot share it again.
An expired grant blocks new local use.

global.sct checks access deadlines before import and before each local read.
It also deletes expired grants at startup, each minute, and after the device resumes.
Cleanup deletes the encrypted vault entry.
The app saves each cleanup result in an encrypted local history.

After successful cleanup, the recipient queues a signed and encrypted expiry notice for the original sender.
The app retries the notice with bounded backoff when the relay reconnects.
The relay keeps each notice for 30 days.
The sender checks the notice. Then the UI reports the access expiry and successful cleanup.

After the vault import, global.sct saves an encrypted signed receipt before it acknowledges the delivery.
The relay keeps the receipt for an offline sender.
The sender verifies the receipt before it reports durable delivery.
The main process maps the verified receipt to the shared `TransferReceipt` with mode `mailbox`.
The `receiptState` field of each sent row carries the shared receipt state.
Retries reuse the original IDs and cannot import the same transfer two times.

A modal shows each relay send and each new arrival. See [send and receive animations](sharing.md#send-and-receive-animations).

Delivery expiry and local access expiry are different states.
A delivery deadline blocks a later import of that transfer.
An access deadline blocks later use of an imported copy and starts local cleanup.
Expiry cannot revoke a credential that a process received already.
It also cannot remove copies that exist outside global.sct.
The [secure sharing check](secure-sharing-check.md) records the issue #20 result and expiry limits.

## Client bindings

`src/main/relay` contains the TypeScript client code that SpacetimeDB generates from `packages/relay`.
After a change to the relay module, generate the code again and commit it:

```sh
bun run relay:generate
```

The script needs the `spacetime` command in your `PATH`. Do not edit the generated files.
