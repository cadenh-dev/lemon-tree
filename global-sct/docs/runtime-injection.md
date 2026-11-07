# CLI and TypeScript runtime injection

global.sct gives a registered project its secrets without `.env` files or project-local manifests.
The CLI and the SDK work offline. They need no relay, no MCP server, and no agent.
In both paths, the signed Electron main process owns the vault key and decryption.
The OS secret store is optional. A passphrase always opens the vault.

## Set up one time

1. Build the app for your platform: `bun run package:mac`, `bun run package:win`, or `bun run package:linux`.
   On macOS, if the build reports a missing identity, do the [local signing setup](macos-signing.md).
2. Install the `sct` command: `bun run install:cli`.
3. If the installer tells you that the command folder is not in `PATH`, add it, then open a new terminal.
   - macOS and Linux: `export PATH="$HOME/.local/bin:$PATH"` in `~/.zshrc` or `~/.profile`.
   - Windows: add `%LOCALAPPDATA%\Programs\global.sct\bin` to the user `PATH`.
4. Open the app from `dist/`:
   - macOS: `dist/global.sct-darwin-arm64/global.sct.app` on Apple Silicon, or `global.sct-darwin-x64` on Intel.
   - Windows: `dist/global.sct-win32-<arch>/sct.exe`.
   - Linux: `dist/global.sct-linux-<arch>/sct`.
5. Register your existing project folder.
6. Save the variables of the project under **Open secrets**.

Keep the vault outside the source folder. The project needs no configuration file.
The desktop window can be open or closed during injection.

### Unlock

Each CLI path needs an unlocked vault.

- When the vault is locked, `sct run` opens one passphrase window from the signed executable.
- `sct _env` and `sct mcp` have no terminal. They open the same window.
- With "Remember this device" on, no window opens.
- The window closes after the vault opens. A window that closes early stops the command with a clear error.

### The `sct` command script

On macOS and Linux, the installer writes `~/.local/bin/sct` as a shell script. The script runs the signed executable with `exec`.
On Windows, the installer writes `%LOCALAPPDATA%\Programs\global.sct\bin\sct.cmd` and `sct.json`.
Electron finds its helper apps only from the real executable path. Thus the command is not a symbolic link.

- The installer replaces an earlier global.sct symbolic link to the same executable.
- The installer keeps other commands. It rejects a script or a link for another application.
- After a rebuild, the script uses the same app location. If you move the app, install the command again.
- A direct MCP client cannot start `sct.cmd`. Use `cmd /c sct mcp` or the full `sct.exe` path.
- The `@sct/env` SDK reads `sct.json` on Windows. Set `SCT_CLI` to use another executable path.

## CLI: one command in your project

From the registered source folder or a subfolder, run:

```sh
sct run -- bun run dev
```

global.sct selects the nearest registered parent folder. The command runs in the registered source folder.
To select a project by its exact name, run:

```sh
sct run "My project" -- npm run dev
```

The command receives the variables of the project before imports or package scripts run.

- Project secrets override inherited variables with the same name. Other inherited variables stay available.
- The parent environment does not change. Secrets of other projects do not go into this environment.
- Values keep spaces, quotes, dollar signs, equals signs, empty strings, Unicode, and newlines.
- The vault rejects null characters, because process environment values cannot contain them.

### Restarts

Keep the command running. When you add, update, or delete a saved key, global.sct restarts the command with the current environment.
You do not run the command again or copy new values into a shell.

- `sct run` checks the encrypted file metadata every 500 milliseconds. It decrypts only when a revision changes.
- `sct run` keeps the selected project ID. It finds renamed projects and moved storage through the current registry and settings.
- `sct run` writes no plaintext file.

A restart interrupts the project, and its normal startup code runs again.
Use this behavior only for development commands whose restart side effects you accept.

1. global.sct sends `SIGTERM` to the process group of the command.
2. global.sct waits a maximum of two seconds for the group to stop. Then it stops the remaining members.
3. global.sct starts the command again.

Windows has no process groups. global.sct uses `taskkill /T` and then `taskkill /T /F` after the grace period.
A Windows command cannot always exit cleanly after Ctrl+C.
A process that moves to another session stays under the control of the program that started it.

### Interactive shells

A restart ends a shell session. A command in a new process group also loses job control in its terminal.
Use `--interactive` for a shell:

```sh
sct run --interactive -- zsh
sct run --interactive "My project" -- pwsh.exe
```

With `--interactive`, these rules apply:

- The shell stays in the terminal of `sct`. On POSIX, it is not in a new session. On Windows, it uses the same console window.
- global.sct does not restart the shell. When a saved key changes, global.sct writes "Secrets changed. Open a new terminal." one time. The shell keeps its start values.
- The terminal sends Ctrl+C and hang-up to the shell. global.sct ignores these signals and forwards nothing.
- `SIGTERM` to `sct` stops the shell, so no shell with secrets stays after `sct` exits.
- The exit code is the exit code of the shell.

On Windows, give the executable of the shell, for example `pwsh.exe` or `cmd.exe`. global.sct starts no shell for you, so a `.cmd` or `.bat` file cannot start.

The VS Code extension uses this form in its **Open terminal with global.sct secrets** command.
Only that terminal gets the project secrets.
See [VS Code extension](vscode.md).

### Input, signals, and exit codes

- Terminal input and output stay connected to the command.
- `Ctrl+C`, `SIGTERM`, and `SIGHUP` go to the process group of the command.
- When the command exits normally, `sct run` exits with the same code.
- When a signal ends the command, `sct run` returns `128 + signal number`.
- global.sct does not start a command again after a normal exit or a crash.

### Failures

- If a missing prerequisite stops the first start, `sct run` fails immediately.
- If a later vault read fails, global.sct stops the command and reports a diagnostic without values.
  global.sct continues to check the storage. When the vault is readable again, global.sct starts the command again.
- A new project needs at least one saved secret. The first secret makes the encrypted vault file.

## TypeScript SDK: load inside your code

The dependency-free [`@sct/env` SDK](../packages/env/README.md) loads the same values inside your process.
It keeps `process.env` current without a restart.

- Build the SDK with `bun run build:sdk`.
- Install it with `bun add /absolute/path/to/global.sct/packages/env`.
- It needs macOS, Windows, or Linux, Node.js 22.18 or later or Bun, and the installed `sct` command.
  On Windows, the SDK reads `sct.json` from the install folder. Set `SCT_CLI` to use another executable path.

The SDK starts a signed helper through private stdin and stdout pipes. It receives only the values of the selected project.
It opens no local server and uses no network service.
The SDK guide tells you how to write the bootstrap file, use `onChange` and `onError`, and stop updates.

## Check your existing project

1. Save a variable named `API_KEY`.
2. Check that the variable is present. This command does not show the value:

   ```sh
   sct run -- node -e 'console.log("API_KEY present:", Object.hasOwn(process.env, "API_KEY"))'
   ```

   The correct result is `API_KEY present: true`. An empty value also counts as present.
3. Run your normal development command through `sct run`, or use the SDK bootstrap.
4. Change a saved value in the app. `sct run` restarts the project. The SDK updates the environment of its own process.

global.sct does not import, delete, or change an existing `.env` file.
Move the values into global.sct before you delete that file from the project.
A program that starts without the SDK and without `sct run` gets no values.

## Loader compatibility

Libraries read inherited environment variables through `process.env`. They do not read or decrypt `secrets.sct`.

- **dotenv:** The default load keeps existing environment variables. Code that needs a successful `.env` read must change when the file is absent.
  `dotenv.parse` parses the contents that you give it. It does not return inherited variables.
  Override modes can replace injected values with other contents. See [dotenv configuration](https://github.com/motdotla/dotenv#config).
- **Bun:** Bun scripts and package scripts get the environment before they run. The automatic `.env` load of Bun does not decrypt the vault.
  See [Bun environment variables](https://bun.sh/docs/runtime/environment-variables).
- **Vite:** Vite gives existing environment variables priority over `.env` values.
  The default `VITE_` prefix puts variables into browser code and build output. Do not use public prefixes or client build definitions for private credentials.
  `sct run` restarts Vite after a key change, so Vite starts with the new environment.
  An SDK update in a server process does not rebuild the browser output that Vite made before.
  See [Vite environment variables and modes](https://vite.dev/guide/env-and-mode).

The #32 loader checks used Node.js 22.23.1, dotenv 18.0.9, Bun 1.4.4, and Vite 8.3.5.
They checked literal values, the behavior without a `.env` file, and that client output contained no private value.
The #32 Python checks do not apply to the TypeScript SDK. The SDK has no Python integration.

## Storage and trust

- Vault files stay encrypted in the external `global.sct/[project-name]/secrets.sct` folder.
- The vault clears decrypted Buffers and copied value keys after use. It deletes temporary environment references after use.
- `sct run` and the SDK make no plaintext secret file, project manifest, copied key, symbolic link, or FIFO in the project.
- The `sct` command script is outside the project: `~/.local/bin` on macOS and Linux, or `%LOCALAPPDATA%\Programs\global.sct\bin` on Windows.
- The renderer API returns metadata only.

A program and its descendants can copy, print, save, or send their environment. Run only code that you trust.
An update or a deletion of a key cannot revoke copies that a program kept.
