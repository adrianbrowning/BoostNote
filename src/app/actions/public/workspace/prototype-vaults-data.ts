// PROTOTYPE (multi-vault, branch prototype/multi-vault): stub vaults in memory. Delete with the prototype.

export interface ProtoNote {
  id: string
  title: string
  updated: string
  body: string
}

export interface ProtoVault {
  /** Stands in for the vault's absolute root: the key a real request would carry. */
  root: string
  name: string
  /** Initials and colour for the rail / dots. */
  short: string
  color: string
  notes: ProtoNote[]
}

const note = (id: string, updated: string, body: string): ProtoNote => ({
  id,
  title: id.split('/').at(-1)?.replace(/\.md$/, '') ?? id,
  updated,
  body,
})

export const PROTO_VAULTS: ProtoVault[] = [
  {
    root: '/Users/me/Notes/Boostnotev2',
    name: 'Boostnotev2',
    short: 'B2',
    color: '#1ec38b',
    notes: [
      note('Inbox.md', '2026-10-30', '- Call the plumber\n- Book flights for December'),
      note('Work/Standup notes.md', '2026-10-29', '## Tuesday\n- Multi-vault prototype\n- Review PR #28'),
      note('Work/1-1 with Sam.md', '2026-10-21', 'Talk about the Q1 roadmap.'),
      note('Recipes/Bread.md', '2026-09-02', '500 g flour, 350 g water, 10 g salt, 4 g yeast.'),
      note('Recipes/Ramen.md', '2026-08-14', 'Tonkotsu broth: 12 hours.'),
    ],
  },
  {
    root: '/Users/me/AgentMemory',
    name: 'AgentMemory',
    short: 'AM',
    color: '#8b5cf6',
    notes: [
      note(
        'global/MEMORY.md',
        '2026-10-30',
        '- omp `.mcp.json`: `${VAR}` expands; nested defaults break.\n- `gh pr edit` fails: use `gh api -X PATCH`.',
      ),
      note(
        'projects/boostnote/MEMORY.md',
        '2026-10-30',
        '- Stacked PRs: `gh stack init --base master <branch>`, then `gh stack submit --auto --open`.',
      ),
    ],
  },
  {
    root: '/Users/me/Work/Team wiki',
    name: 'Team wiki',
    short: 'TW',
    color: '#f59e0b',
    notes: [
      note('Onboarding.md', '2026-10-12', 'Welcome! Start with the runbooks.'),
      note('Runbooks/Deploy.md', '2026-10-28', '1. Tag the release\n2. Watch the dashboard'),
      note('Runbooks/Rollback.md', '2026-07-03', 'Revert the tag, then redeploy.'),
    ],
  },
]

/** Top-level folders of a vault, from its note ids (the prototype has no nested folders). */
export function protoFolders(vault: ProtoVault): string[] {
  const folders = new Set<string>()
  for (const item of vault.notes) {
    const slash = item.id.indexOf('/')
    if (slash > 0) folders.add(item.id.slice(0, slash))
  }
  return [...folders].sort()
}

/** A tab names its vault: with several vaults open, a note id alone is ambiguous. */
export interface ProtoTab {
  root: string
  id: string
}
