# Boostnote vault memory for omp

An [omp](https://github.com/can1357/oh-my-pi) plugin that gives the agent long-term memory in a
Boostnote vault of its own: `global/MEMORY.md` for every project and `projects/<slug>/MEMORY.md` for
the current one. You read and edit the same notes in the Boostnote app.

It has three parts, all in this folder:

- `.mcp.json` starts `boostnote mcp` on the memory vault as the `boostnote-memory` MCP server.
- `extension.ts` puts both `MEMORY.md` notes into the conversation once per session (a hidden
  message before the first prompt, kept in the session file, so `--continue` does not load it again)
  and adds `/vault-memory`, which shows the vault and the project folder.
- `skills/vault-memory` tells the agent what to keep, where, and how to write it safely
  (read first, then `append_to_note` / `write_note` with `baseHash`).

## Install

From a checkout of this repository (the packaged app does not include this folder):

```sh
pnpm install
omp plugin link "$PWD/integrations/omp"
```

Start a new omp session. The first prompt creates the vault folders if they are missing.

| Variable                 | Default                           | Use                             |
| ------------------------ | --------------------------------- | ------------------------------- |
| `BOOSTNOTE_MEMORY_VAULT` | `~/AgentMemory`                   | The memory vault                |
| `BOOSTNOTE_CLI`          | this checkout's `src/cli/index.js` | The `boostnote` command to run  |

Keep the memory vault apart from your own notes: the agent writes to it without asking each time.
Open it in Boostnote (File › Open Vault…) to read, fix or prune what it saved.

`<slug>` is the lowercased name of the repository's main checkout (worktrees share it), else the name
of the working folder. omp's own memory (`memory.backend`) works without this plugin; turn it `off` if
you do not want two memories.
