# Sharing between devices

Device pairing works on macOS, Windows, and Linux.
The pairing link and the `.sct-device` file contain public keys only.
Link mode works on all platforms.
AirDrop sending is macOS-only.

global.sct sends encrypted copies of secrets to a verified device.
The Link, Direct, WebRTC, Mailbox, and AirDrop flows need no agent.
The Link, Direct, and WebRTC flows need no relay.
The AirDrop flow also needs no network connection other than AirDrop.
On macOS, the **Sharing** screen has these tabs: **Verify devices**, **Send**, **Send secrets**, **Receive secrets**, **Relay**, **Link**, **Direct**, and **WebRTC**.
On Windows and Linux, it has these tabs: **Verify devices**, **Send**, **Relay**, **Link**, **Direct**, and **WebRTC**.
The **Send** tab chooses a delivery mode from the connections that are available now.
The **Send secrets** tab uses AirDrop on macOS.
The **Relay** tab configures Mailbox delivery and shows relay activity.
This page describes pairing, the delivery modes, and the macOS AirDrop tabs.
See [relay setup](relay.md) for the **Relay** tab.
See [Windows and Linux](windows-linux.md) for the platform limits.

Build the signed app with `bun run package:mac`. Then macOS opens `.sct-transfer` files in global.sct.
The development window registers no file type.

## Verify a device one time

When you open **Sharing** for the first time, global.sct creates a sharing identity in the vault.
Do these steps on both devices:

1. Open **Sharing**, then open the **Verify devices** tab.
2. Select **Copy pairing link**, or select **Save device card…** to write a `.sct-device` file.
3. Send the link or the file to the other device.
4. Ask the other person to send their link or file back.
5. Paste the link and select **Review pairing link**. Or select **Import .sct-device file…** and choose their card.
6. Compare the full pairing code on both devices. Use a trusted conversation, for example in person or on a call.
7. If both codes are the same, select **I compared this code on both devices**. Then select **Confirm recipient**.
8. If the codes are different, select **Cancel verification**.

On macOS, you can also select **Send my card to…** and choose the other Mac in the AirDrop picker.
If the keys of one device change, verify that device again.
The **Send secrets** tab stays unavailable until you verify one device.
On Windows and Linux, use the **Send** tab with Link, Direct, WebRTC, or Mailbox.

## Confirm every share

Every outgoing operation asks for the vault passphrase.
The dialog shows the recipient, the project, the secret names, and the delivery mode.
The confirmation applies to that operation only and expires after two minutes.
A wrong passphrase sends nothing.
**Cancel share** sends nothing.
The main process holds the operation, so a changed window cannot select a different recipient or secret set.
A resend needs a new confirmation.
Receipts and relay acknowledgments do not need a confirmation.

## Choose a delivery mode

1. Open the **Send** tab.
2. Choose the source project and the secret names.
3. Choose a mode that is available now.
4. Set the optional access expiry and the injection-only rule.
5. Select **Send secrets**. Then enter the vault passphrase.

The default mode is Direct when an authenticated Direct session exists.
WebRTC is available when an authenticated WebRTC session exists.
Link is always available for a verified device.
Mailbox is available only with a configured relay, a verified relay device, and the permission checkbox.
The permission checkbox is off for each new operation.
If no Direct session exists and you select the permission, the default mode is Mailbox.
Otherwise, the default mode is Link.
A failed Direct connection never uploads the transfer to Mailbox.
If a Link is too large, select fewer secrets or choose Direct, WebRTC, or Mailbox.

## Send by AirDrop

1. Open the **Send secrets** tab. You can also select **Share secrets** on a project page. Then global.sct keeps that project selected.
2. Choose the source project.
3. Choose a verified recipient.
4. Choose the secrets.
5. Select **Send to…**. Then enter the vault passphrase.
6. In the picker, choose the same Mac.

global.sct encrypts the package for that device before it writes the transfer file.
The helper `native/airdrop.swift` opens only the AirDrop picker. It does not open the full macOS share menu.
macOS reports the same result for a sent file and for **Cancel**. Thus the sender gets no delivery confirmation.

## Receive

1. Accept the AirDrop file. macOS saves it in Downloads.
2. Open the file. The signed app opens `.sct-transfer` files.
   As an alternative, open the **Receive secrets** tab and select **Choose received file…**.
3. Choose a local destination project.
4. Select **Import secrets**.

The sender's project name and folder do not select the destination.
global.sct saves the copies in the vault file of the destination project. Each copy gets a new data key.
If a secret name already exists in the destination, the import fails before any secret changes.

## Direct mode

Direct mode sends an encrypted transfer to a verified peer without a relay.
Both apps must be open and unlocked. Both peers must be online at the same time.
Hyperswarm is the normal Direct path.

1. Open **Sharing**, then open the **Direct** tab to check the connection.
2. Open the **Send** tab. Choose the source project, the secrets, and the Direct mode.
3. Select **Send secrets**. Then enter the vault passphrase.
4. On the recipient, choose a destination project and select **Import and send receipt**.

A device shows **online** after both apps authenticate.
The sender receives the signed receipt in the same session and the row changes to `received`.
If the session closes before the receipt returns, the row changes to `manual` after ten minutes.
Paste the receipt link from the recipient to verify it.
The recipient can open **Receipts to return** in the **Direct** tab and copy the saved signed link.

Direct uses Hyperswarm discovery and an encrypted connection. The discovery topic changes each UTC day.
A failed connection shows **Peer not reachable**. Use Link, WebRTC, or Mailbox.
Direct never uploads a failed transfer to Mailbox.
The transfer deadline is 24 hours. A Direct session has no automatic retry.

## WebRTC mode

WebRTC mode uses one manual offer link and one manual answer link.
Both apps must be open and unlocked.
No signalling server exists.

1. On the sender, open the **WebRTC** tab. Choose a verified device and select **Create WebRTC offer**.
2. Send the offer link to the recipient through a trusted conversation.
3. On the recipient, paste the offer link and select **Create answer**.
4. Send the answer link back to the sender.
5. On the sender, paste the answer link and select **Accept answer**.
6. When the connection is ready, open the **Send** tab and choose the WebRTC mode.

The offer and answer links are signed and encrypted for the verified peer.
Each link expires after five minutes.
The connection starts within 30 seconds after the answer.
The app sends framed data in chunks and stops an oversized or incomplete transfer.
The sender receives the signed receipt over the same data channel.
If the receipt does not return, the row changes to `manual` after ten minutes.
The recipient can open **Receipts to return** in the **WebRTC** tab and copy the saved signed link.

The **WebRTC network settings** panel configures the connection:
- No server is the default. Connections use direct candidates.
- A public STUN server is optional.
- One TURN server can have up to two URLs, a username, and a password.
- **Use TURN only** blocks direct candidates.
- The TURN password stays in the vault. The visible window reads only the server names.
- The connection label shows **Direct via TURN** when the selected path uses a relay candidate.

A TURN server forwards encrypted traffic. It is not durable Mailbox storage.
A connection link from the operating system opens the **WebRTC** tab and shows the sender.
The app never accepts the link on arrival.

## Mailbox mode

Mailbox mode uses the configured relay for an encrypted server copy.
The relay stores ciphertext and routing metadata. It does not store secret values or private keys.
Mailbox needs a configured relay, a verified relay device, and the permission checkbox in the **Send** tab.
The permission checkbox starts off for each new operation.
For peers that you paired only outside the relay, pair them again in the **Relay** tab.
The **Relay** tab shows the same delivery and receipt states.
See [relay setup](relay.md) for the server, pairing, and retention rules.

## Link mode

A Link is a text string that carries an encrypted transfer. Use any trusted conversation to send it.
The link contains ciphertext and one wrapped key. It does not contain a secret value.
Only the verified recipient can open it.
A link has a maximum of 16,384 characters and expires after 24 hours.

### Send a link

1. Open **Sharing**, then open the **Link** tab.
2. Choose the source project.
3. Choose a verified recipient.
4. Choose the secrets.
5. Set the optional access expiry and the injection-only rule.
6. Select **Create link**. Then enter the vault passphrase.
7. Select **Copy link** and send the link to the recipient.

The **Sent links** list keeps the link and its record after a restart.
If the link is too large, select fewer secrets or use Direct, WebRTC, or Mailbox.

### Receive a link

1. Open the **Link** tab.
2. Paste the import link in **Paste import link**.
3. Select **Review link**.
4. Check the sender, project name, secret names, deadline, access expiry, and injection-only rule.
5. Choose a destination project.
6. Select **Import secrets**.
7. Select **Copy receipt link** and send the receipt link to the sender.

### Verify a link receipt

1. On the sender device, find the transfer in **Sent links**.
2. Paste the receipt link in **Paste receipt link**.
3. Select **Verify receipt**.

The state changes to `received` after the signature check.
A receipt from a different device or transfer fails.
After a restart, the saved record and its receipt state stay in the vault sharing folder.

### Open a link from another app

The packaged app can receive `global-sct://` links from the operating system.
Open **Storage**, find **Links**, and select **Register global.sct links**.
The action is per user and needs no administrator rights.

- A pairing link opens **Verify devices** and fills **Paste pairing link**.
- An import link opens **Link** and fills **Paste import link**.
- A receipt link opens **Link** and asks you to select the sent link that it answers.
- A connection link opens **WebRTC** and shows the sender and the link type. It does not connect until you select the action.

Nothing imports on arrival. Review the link and confirm the operation.
The app holds one waiting link. If another link arrives, choose the link to keep.
If another app owns `global-sct` links, select **Replace handler**.
If the registration is not available, use paste.

On Windows and Linux, moving the portable package changes the registered executable path.
Register the links again from the new location.
On macOS, use the packaged `global.sct.app` for external link checks. The development build uses paste.

## Rules

- A package expires after 24 hours. A package holds a maximum of 1000 secrets and 8 MiB.
- A Link has a maximum of 16,384 characters. An expired Link fails import.
- Before an import, global.sct checks the verified sender, the signature, the recipient, the timestamps, and the message ID.
- Receipt records and encrypted vault markers prevent a second import of the same package.
  The Link and Direct modes use the same vault transfer ID, so one envelope cannot be imported twice across those modes.
  This protection also applies after a restart or after an interrupted import.
  An interrupted import stays bound to its first destination project.
- An import makes a permanent local copy. Package expiry does not revoke an imported secret.
- global.sct does not send a secret that arrived through the relay with an injection-only grant or an expired grant.
- global.sct keeps outbound ciphertext in its app data until the app stops.
  After a crash, global.sct deletes expired packages when it starts again.
- An import or **Dismiss transfer** deletes the pending copy in the app data.
  The AirDrop file stays in Downloads. You can delete it after the import.
- Every outgoing share needs the vault passphrase. The main process holds the selected operation until the passphrase check succeeds.
- A failed Direct or WebRTC connection does not fall back to Mailbox automatically.
- TURN passwords stay in the vault's `.internal` area. The visible window reads only the server names.
- Secret values and private keys never go into transfer files, logs, or renderer responses.
  Values exist in main-process memory during encryption and import. JavaScript cannot clear strings from memory.

## Send and receive animations

A modal shows each send and each arrival. The **Cards** screen uses the same modal. See [mock Wallet cards](wallet-cards.md).

- A drawing of the sender's Mac is on the left. A drawing of the recipient is on the right: a Mac, or an iPhone for a Wallet card.
- An object moves between the two drawings. A device card shows the device name and fingerprint.
  Secrets move as a key. A Wallet card moves as a credit card.
- An AirDrop send shows concentric rings in the middle. macOS reports no delivery.
  Thus the object goes into the rings and never lands on the recipient. The caption tells you that macOS does not confirm delivery.
- A relay send shows a SpacetimeDB hub in the middle. The key waits in the hub while the transfer is in the queue.
  The key lands on the recipient only when the relay reports `received`. You can close the modal while the key waits.
- A relay arrival shows the modal only while the **Relay** tab is open.
- After an import, the key lands on the project that you chose. An AirDrop import starts at the sender.
  A relay import goes from the sender through the hub.
- A relay send plays a quiet swoosh. The app makes the sound at run time with the Web Audio API.
- After the object goes into the rings or lands, the modal closes after 1.5 s.
  You cannot close it while the app makes the file or the transfer, or while the AirDrop picker is open.
- Reduced-motion settings show the final frame of each stage with no movement.
- Secret names change to random glyphs during encryption and back to the names after import.
  The glyphs are decoration. They do not show ciphertext. Screen readers get the real names.
