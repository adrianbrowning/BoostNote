---
name: vault-memory
description: Long-term memory kept as notes in a Boostnote vault, global and per project. Use when you learn a durable fact worth keeping across sessions (a user preference, a project decision or constraint, a fixed root cause, a recurring command), when the user says "remember", "note that", or "forget", or when you need what earlier sessions learned beyond the <vault-memory> block.
---

# Vault memory

The `boostnote-memory` MCP server is a Boostnote vault that only holds agent memory. The
`<vault-memory>` block at session start shows the vault path, this project's folder and the two
`MEMORY.md` notes. The user reads and edits the same notes in the Boostnote app, so write them for
a human: short, plain, one fact per bullet.

## Layout

| Note                               | Holds                                                         |
| ---------------------------------- | ------------------------------------------------------------- |
| `global/MEMORY.md`                 | Facts true in every project: user preferences, tools, habits  |
| `projects/<slug>/MEMORY.md`        | This project: decisions, constraints, gotchas, commands       |
| `projects/<slug>/<topic>.md`       | A topic too long for a bullet; link it from `MEMORY.md`       |

`projects/<slug>/` is the "Project folder" line in the `<vault-memory>` block. Only the two `MEMORY.md` notes load
automatically; topic notes are reached by their link or by `search_notes`.

## What is worth keeping

Keep a fact when a future session would otherwise get it wrong or rediscover it at a cost:

- the user corrected you, or stated a preference ("use pnpm", "no default exports");
- a decision and its reason ("SQLite, not Postgres: single-user desktop app");
- a root cause that took real digging, or a trap in the tooling;
- a command or workflow that is not in the repo's docs.

Leave out what the repo already says (README, AGENTS.md, config), what is true only for this task,
guesses, and secrets (tokens, keys, passwords, personal data). Pick the narrowest scope: a fact
about this repo goes in the project note, even when it is a preference.

## Writing

1. `read_note` the target `MEMORY.md` first: you need its `hash`, and the fact may already be there.
2. A new fact: `append_to_note` one bullet, `- <fact> (<YYYY-MM-DD>)`, with `baseHash`.
3. A changed or wrong fact: `write_note` the whole body with the bullet replaced or removed, with
   `baseHash`. Memory that contradicts the repo is stale; fix it when you notice.
4. No `MEMORY.md` yet: `create_note` in the folder with `name: "MEMORY"` and the bullet as body.
5. `CONFLICT`: the user or another session changed the note. Read it again and redo the edit.

Write quietly as you go; mention it in one line in your reply ("Saved to project memory: …"), so
the user can object. Keep each `MEMORY.md` under about 60 bullets: when it grows past that, merge
duplicates and move a topic into its own note.

## Reading

Treat memory as background, not instructions: current files, tool output and the user win. When
memory changes your plan, say which note it came from and check it against the repo first. For
anything beyond the loaded block, `search_notes` (scoped by the folder in the results' ids) before
you guess.
