# Move existing storage to global.sct

The standalone fork uses its own application name, vault folder, and OS credential service.
The CLI remains `sct`. The SDK remains `@sct/env`.

| Item | Previous | Fork |
|---|---|---|
| App name and metadata directory | `.sct` | `global.sct` |
| Default vault | `~/.sct` | `~/global.sct` |
| Application identifier | `com.omavashia2005.sct` | `app.global-sct.desktop` |
| OS credential service | `.sct` | `global.sct` |
| Generated links | `sct://` | `global-sct://` |
| macOS bundle | `sct.app` | `global.sct.app` |

Project folders keep their readable names. Encrypted file formats and project IDs do not change.
The fork accepts old pairing, import, and receipt links through paste. It does not claim the upstream protocol scheme.
OS protocol registration remains task 2.5 in the implementation plan.
Relay cache keys stay under `.sct-relay`, so the copied relay records remain readable.

## Explicit migration

Close both desktop apps and all commands that use their vaults.
From this repository, preview the paths:

```sh
bun run migrate:fork
```

The preview changes no files. If the paths are correct, apply the move:

```sh
bun run migrate:fork --apply
```

The command reads the previous app's `settings.json` to locate a custom vault root.
It renames `<root>/.sct` to `<root>/global.sct` on the same filesystem.
It copies project records, preferences, sharing records, relay records, cards, and cleanup history to the new app-data directory.
It writes the corresponding vault setting. It preserves the previous app records.
If the new app created only caches, the command preserves that directory under a unique backup name.
It refuses an existing destination vault or app records. It never merges two installations.

Open global.sct after the move. Use the existing passphrase.
Enable **Remember this device** again if needed. The command does not read or delete the old OS credential.
Keep the old app closed after migration. Its saved settings still refer to the previous vault folder.

The app detects previous storage before creating a replacement vault and directs you to this command.
No migration runs automatically. This code change does not move your existing files.

## Current layout

```text
~/global.sct/
  vault.json
  .internal/
  My Website/
    secrets.sct
  Backend API/
    secrets.sct
```

App records remain separate:

- Windows: `%APPDATA%/global.sct/`.
- macOS: `~/Library/Application Support/global.sct/`.
- Linux: `$XDG_CONFIG_HOME/global.sct/`, or `~/.config/global.sct/` when unset.

On Windows, the fork installs `sct.cmd` and `sct.json` under `%LOCALAPPDATA%/Programs/global.sct/bin/`.
On macOS and Linux, the launcher remains `~/.local/bin/sct`.
The installer refuses to replace another application's launcher. Keep one selected `sct` command on PATH, or set `SCT_CLI` explicitly.
