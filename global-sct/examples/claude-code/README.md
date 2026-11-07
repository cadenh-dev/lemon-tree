# Claude Code demo project

This folder is a demo-only Claude Code project for local Agent Access.
It connects Claude Code to the installed `sct mcp` server and blocks every other tool path.

- `.mcp.json` starts `${HOME}/.local/bin/sct mcp`. It contains no credentials.
- `.claude/settings.json` enables only the `sct` server and denies the built-in shell, file, web, agent, and scheduling tools.
  Claude Code keeps `ToolSearch` so that it can load the MCP tools.

## Prepare

1. From the repository root, run `bun run package:mac`.
2. Run `bun run install:cli`.
3. Open the signed .sct app. Choose a storage location outside this repository.
4. Start Claude Code in this folder. Ask it to call `project_setup`.
5. Approve the request in the .sct window.
6. In the .sct app, add a test secret named `SCT_DEMO_TOKEN` to this project. Use a test value only.

## Start Claude Code

Interactive session:

```sh
claude --setting-sources project
```

Headless check that uses only the configuration of this folder:

```sh
claude -p "Call mcp__sct__list_secrets with {} and report the result." \
  --setting-sources project --strict-mcp-config --mcp-config .mcp.json \
  --allowedTools mcp__sct__list_secrets --output-format stream-json --verbose
```

To check the Claude Code permission denial, delete the tool from `--allowedTools`.
Each allowed call still opens the .sct approval window. Approve or refuse it there.

## What to check

- Claude Code lists the nine `mcp__sct__*` tools and no shell or file tools.
- The .sct window shows `Caller: Claude Code. macOS verified its code signature.`
- `run_demo` starts the demo only after approval. Refusal and expiry start nothing.
- A missing project, an extra input field, or an expired deadline fails before approval.
- An approval applies to one request. The next request opens a new approval.
- Transcripts, results, and MCP logs contain no secret value.
- This folder contains no `.env` file or other secret file after the checks.
