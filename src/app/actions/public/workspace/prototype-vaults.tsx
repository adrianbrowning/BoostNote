// PROTOTYPE (multi-vault, branch prototype/multi-vault). Throwaway: never merge to master.
// Question: what should several open vaults look like? Three variants of the workspace on
// `/prototype/vaults?variant=A|B|C`, switched from the floating bar (or ← / →). Stub data, no writes.
import type { Handle } from 'remix/component'
import { clientEntry, css, on } from 'remix/component'

import { PROTO_VAULTS, type ProtoNote, type ProtoTab, type ProtoVault, protoFolders } from './prototype-vaults-data.ts'
import { iconButton, muted, paneHeading } from './styles.ts'

const VARIANTS = [
  { key: 'A', name: 'Vault rail' },
  { key: 'B', name: 'One sidebar, many vaults' },
  { key: 'C', name: 'Window per vault' },
] as const
type VariantKey = (typeof VARIANTS)[number]['key']

/** What one vault remembers while it is open (variants A and C): its selection and its own tabs. */
interface VaultView {
  folder: string | null
  tabs: string[]
  active: string | null
}

const vaultOf = (root: string): ProtoVault => PROTO_VAULTS.find((vault) => vault.root === root) ?? PROTO_VAULTS[0]!
const noteOf = (tab: ProtoTab): ProtoNote | undefined => vaultOf(tab.root).notes.find((item) => item.id === tab.id)
const inFolder = (vault: ProtoVault, folder: string | null) =>
  vault.notes.filter((item) => folder === null || item.id.startsWith(`${folder}/`))

export const PrototypeVaults = clientEntry(
  import.meta.url,
  function PrototypeVaults(handle: Handle<{ variant: string }>) {
    let variant: VariantKey = VARIANTS.some((item) => item.key === handle.props.variant)
      ? (handle.props.variant as VariantKey)
      : 'A'
    // Team wiki starts closed, so "open another vault" can be tried in every variant.
    let open = PROTO_VAULTS.slice(0, 2).map((vault) => vault.root)
    let active = open[0]!
    const views = new Map<string, VaultView>()
    const viewOf = (root: string): VaultView => {
      let view = views.get(root)
      if (!view) {
        view = { folder: null, tabs: [], active: null }
        views.set(root, view)
      }
      return view
    }
    // Variant B: one selection and one tab strip across vaults, so tabs carry their vault.
    let mixedSelection: { root: string | null; folder: string | null } = { root: null, folder: null }
    let mixedTabs: ProtoTab[] = []
    let mixedActive: ProtoTab | null = null
    const collapsed = new Set<string>()
    let windowMenu = false

    const update = () => void handle.update()
    const setVariant = (next: VariantKey) => {
      variant = next
      const url = new URL(location.href)
      url.searchParams.set('variant', next)
      history.replaceState(null, '', url)
      update()
    }
    const cycle = (step: number) => {
      const index = VARIANTS.findIndex((item) => item.key === variant)
      setVariant(VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length]!.key)
    }
    const openVault = (root: string) => {
      if (!open.includes(root)) open = [...open, root]
      active = root
      windowMenu = false
      update()
    }
    const closeVault = (root: string) => {
      open = open.filter((item) => item !== root)
      mixedTabs = mixedTabs.filter((tab) => tab.root !== root)
      if (mixedActive?.root === root) mixedActive = mixedTabs[0] ?? null
      if (mixedSelection.root === root) mixedSelection = { root: null, folder: null }
      if (active === root) active = open[0] ?? ''
      update()
    }
    const openNote = (root: string, id: string) => {
      const view = viewOf(root)
      if (!view.tabs.includes(id)) view.tabs = [...view.tabs, id]
      view.active = id
      if (!mixedTabs.some((tab) => tab.root === root && tab.id === id)) mixedTabs = [...mixedTabs, { root, id }]
      mixedActive = { root, id }
      update()
    }
    const closed = () => PROTO_VAULTS.filter((vault) => !open.includes(vault.root))

    handle.queueTask(() => {
      window.addEventListener(
        'keydown',
        (event) => {
          if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]')) return
          if (event.key === 'ArrowLeft') cycle(-1)
          else if (event.key === 'ArrowRight') cycle(1)
        },
        { signal: handle.signal },
      )
    })

    // ── Pieces shared by the variants ──────────────────────────────────────────────────────
    const dot = (vault: ProtoVault) => <span mix={dotStyle} style={`background: ${vault.color}`} aria-hidden="true" />

    const folderRows = (
      vault: ProtoVault,
      selected: string | null | undefined,
      pick: (folder: string | null) => void,
    ) => (
      <ul mix={listStyle}>
        <li>
          <button
            type="button"
            mix={[rowStyle, on('click', () => pick(null))]}
            data-selected={selected === null ? 'true' : undefined}
          >
            <span mix={iconStyle}>≡</span>
            <span mix={labelStyle}>All notes</span>
            <span mix={countStyle}>{vault.notes.length}</span>
          </button>
        </li>
        {protoFolders(vault).map((folder) => (
          <li key={folder}>
            <button
              type="button"
              mix={[rowStyle, on('click', () => pick(folder))]}
              data-selected={selected === folder ? 'true' : undefined}
            >
              <span mix={iconStyle}>▸</span>
              <span mix={labelStyle}>{folder}</span>
              <span mix={countStyle}>{inFolder(vault, folder).length}</span>
            </button>
          </li>
        ))}
      </ul>
    )

    const noteRows = (
      items: { vault: ProtoVault; note: ProtoNote }[],
      isActive: (tab: ProtoTab) => boolean,
      badge: boolean,
    ) => (
      <ul mix={listStyle}>
        {items.map(({ vault, note }) => (
          <li key={`${vault.root}:${note.id}`}>
            <button
              type="button"
              mix={[noteRowStyle, on('click', () => openNote(vault.root, note.id))]}
              data-selected={isActive({ root: vault.root, id: note.id }) ? 'true' : undefined}
            >
              <strong mix={labelStyle}>{note.title}</strong>
              <span mix={[muted, smallStyle]}>
                {badge ? (
                  <>
                    {dot(vault)} {vault.name} ·{' '}
                  </>
                ) : null}
                {note.updated}
              </span>
            </button>
          </li>
        ))}
        {items.length === 0 ? <li mix={[muted, smallStyle, padStyle]}>No notes</li> : null}
      </ul>
    )

    const editor = (tab: ProtoTab | null, crumbs: boolean) => {
      const item = tab ? noteOf(tab) : undefined
      if (!tab || !item) return <p mix={[muted, padStyle]}>Open a note from the list.</p>
      const vault = vaultOf(tab.root)
      return (
        <article mix={editorBodyStyle}>
          {crumbs ? (
            <p mix={[muted, smallStyle]}>
              {dot(vault)} {vault.name} › {tab.id}
            </p>
          ) : null}
          <h1 mix={titleStyle}>{item.title}</h1>
          <pre mix={bodyStyle}>{item.body}</pre>
        </article>
      )
    }

    // ── A: a rail of open vaults; each keeps its own tabs and selection ──────────────────
    const variantA = () => {
      const vault = vaultOf(active)
      const view = viewOf(active)
      return (
        <div mix={[shellStyle, railGridStyle]}>
          <nav mix={railStyle} aria-label="Open vaults">
            {open.map((root) => {
              const item = vaultOf(root)
              return (
                <button
                  key={root}
                  type="button"
                  title={`${item.name}\n${item.root}`}
                  aria-label={item.name}
                  mix={[railButtonStyle, on('click', () => openVault(root))]}
                  style={`background: ${item.color}`}
                  aria-pressed={root === active ? 'true' : 'false'}
                >
                  {item.short}
                  {viewOf(root).tabs.length > 0 ? <span mix={railBadgeStyle}>{viewOf(root).tabs.length}</span> : null}
                </button>
              )
            })}
            {closed().map((item) => (
              <button
                key={item.root}
                type="button"
                title={`Open ${item.name}`}
                mix={[railButtonStyle, railAddStyle, on('click', () => openVault(item.root))]}
              >
                +
              </button>
            ))}
          </nav>
          <aside mix={sidebarStyle}>
            <div mix={vaultHeaderStyle}>
              <span mix={labelStyle}>{vault.name}</span>
              <button
                type="button"
                mix={[iconButton, on('click', () => closeVault(active))]}
                title="Close this vault"
                aria-label="Close this vault"
              >
                ×
              </button>
            </div>
            {folderRows(vault, view.folder, (folder) => {
              view.folder = folder
              update()
            })}
          </aside>
          <section mix={noteListStyle}>
            {noteRows(
              inFolder(vault, view.folder).map((item) => ({ vault, note: item })),
              (tab) => tab.root === active && tab.id === view.active,
              false,
            )}
          </section>
          <main mix={editorStyle}>
            <div mix={tabStripStyle}>
              {view.tabs.map((id) => (
                <button
                  key={id}
                  type="button"
                  mix={[tabStyle, on('click', () => openNote(active, id))]}
                  aria-pressed={id === view.active ? 'true' : 'false'}
                >
                  {vault.notes.find((item) => item.id === id)?.title}
                </button>
              ))}
            </div>
            {editor(view.active ? { root: active, id: view.active } : null, false)}
          </main>
        </div>
      )
    }

    // ── B: every open vault is a section of one sidebar; tabs mix vaults ────────────────
    const variantB = () => {
      const pickAll = () => {
        mixedSelection = { root: null, folder: null }
        update()
      }
      const items =
        mixedSelection.root === null
          ? open.flatMap((root) => vaultOf(root).notes.map((item) => ({ vault: vaultOf(root), note: item })))
          : inFolder(vaultOf(mixedSelection.root), mixedSelection.folder).map((item) => ({
              vault: vaultOf(mixedSelection.root ?? ''),
              note: item,
            }))
      items.sort((a, b) => b.note.updated.localeCompare(a.note.updated))
      return (
        <div mix={[shellStyle, multiGridStyle]}>
          <aside mix={sidebarStyle}>
            <button
              type="button"
              mix={[rowStyle, on('click', pickAll)]}
              data-selected={mixedSelection.root === null ? 'true' : undefined}
            >
              <span mix={iconStyle}>≡</span>
              <span mix={labelStyle}>All vaults</span>
              <span mix={countStyle}>{open.reduce((sum, root) => sum + vaultOf(root).notes.length, 0)}</span>
            </button>
            {open.map((root) => {
              const vault = vaultOf(root)
              const folded = collapsed.has(root)
              return (
                <section key={root} mix={sectionStyle}>
                  <div mix={sectionHeaderStyle}>
                    <button
                      type="button"
                      mix={[
                        sectionToggleStyle,
                        on('click', () => {
                          if (folded) collapsed.delete(root)
                          else collapsed.add(root)
                          update()
                        }),
                      ]}
                      title={vault.root}
                    >
                      <span aria-hidden="true">{folded ? '▸' : '▾'}</span>
                      {dot(vault)}
                      <span mix={[paneHeading, labelStyle]}>{vault.name}</span>
                    </button>
                    <button
                      type="button"
                      mix={[iconButton, on('click', () => closeVault(root))]}
                      title={`Close ${vault.name}`}
                      aria-label={`Close ${vault.name}`}
                    >
                      ×
                    </button>
                  </div>
                  {folded
                    ? null
                    : folderRows(vault, mixedSelection.root === root ? mixedSelection.folder : undefined, (folder) => {
                        mixedSelection = { root, folder }
                        update()
                      })}
                </section>
              )
            })}
            {closed().map((vault) => (
              <button key={vault.root} type="button" mix={[rowStyle, muted, on('click', () => openVault(vault.root))]}>
                <span mix={iconStyle}>+</span>
                <span mix={labelStyle}>Open {vault.name}…</span>
              </button>
            ))}
          </aside>
          <section mix={noteListStyle}>
            {noteRows(
              items,
              (tab) => mixedActive?.root === tab.root && mixedActive.id === tab.id,
              mixedSelection.root === null,
            )}
          </section>
          <main mix={editorStyle}>
            <div mix={tabStripStyle}>
              {mixedTabs.map((tab) => (
                <button
                  key={`${tab.root}:${tab.id}`}
                  type="button"
                  title={`${vaultOf(tab.root).name} › ${tab.id}`}
                  mix={[tabStyle, on('click', () => openNote(tab.root, tab.id))]}
                  aria-pressed={mixedActive?.root === tab.root && mixedActive.id === tab.id ? 'true' : 'false'}
                >
                  {dot(vaultOf(tab.root))}
                  {noteOf(tab)?.title}
                </button>
              ))}
            </div>
            {editor(mixedActive, true)}
          </main>
        </div>
      )
    }

    // ── C: one OS window per vault (drawn as windows on a fake desktop) ─────────────────
    const variantC = () => (
      <div mix={desktopStyle}>
        <div mix={menuBarStyle}>
          <strong>Boostnote</strong>
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span mix={menuAnchorStyle}>
            <button
              type="button"
              mix={[
                menuButtonStyle,
                on('click', () => {
                  windowMenu = !windowMenu
                  update()
                }),
              ]}
              aria-expanded={windowMenu ? 'true' : 'false'}
            >
              Window
            </button>
            {windowMenu ? (
              <div mix={menuStyle} role="menu">
                {open.map((root) => (
                  <button
                    key={root}
                    type="button"
                    role="menuitem"
                    mix={[menuItemStyle, on('click', () => openVault(root))]}
                  >
                    <span mix={checkStyle}>{root === active ? '✓' : ''}</span>
                    {vaultOf(root).name}
                  </button>
                ))}
                <hr mix={menuRuleStyle} />
                {closed().map((vault) => (
                  <button
                    key={vault.root}
                    type="button"
                    role="menuitem"
                    mix={[menuItemStyle, on('click', () => openVault(vault.root))]}
                  >
                    <span mix={checkStyle} />
                    Open {vault.name} in New Window
                  </button>
                ))}
              </div>
            ) : null}
          </span>
        </div>
        {open.map((root, index) => {
          const vault = vaultOf(root)
          const view = viewOf(root)
          return (
            <section
              key={root}
              mix={[
                windowStyle,
                on('pointerdown', () => {
                  if (active !== root) {
                    active = root
                    update()
                  }
                }),
              ]}
              data-focused={root === active ? 'true' : undefined}
              style={`left: ${24 + index * 70}px; top: ${44 + index * 56}px; z-index: ${root === active ? 10 : index + 1}`}
              aria-label={`${vault.name} window`}
            >
              <header mix={titleBarStyle}>
                <button
                  type="button"
                  mix={[trafficStyle, on('click', () => closeVault(root))]}
                  aria-label={`Close ${vault.name} window`}
                  title="Close window: closes this vault; its tabs come back when you reopen it"
                />
                <span mix={trafficStyle} style="background: #febc2e" />
                <span mix={trafficStyle} style="background: #28c840" />
                <span mix={windowTitleStyle}>{vault.name}</span>
              </header>
              <div mix={miniGridStyle}>
                <aside mix={sidebarStyle}>
                  {folderRows(vault, view.folder, (folder) => {
                    view.folder = folder
                    update()
                  })}
                </aside>
                <section mix={noteListStyle}>
                  {noteRows(
                    inFolder(vault, view.folder).map((item) => ({ vault, note: item })),
                    (tab) => tab.root === root && tab.id === view.active,
                    false,
                  )}
                </section>
                <main mix={editorStyle}>{editor(view.active ? { root, id: view.active } : null, false)}</main>
              </div>
            </section>
          )
        })}
      </div>
    )

    // ── State readout: the part of the state model each variant depends on ──────────────
    const state = () => {
      const perVault = Object.fromEntries(open.map((root) => [vaultOf(root).name, viewOf(root)]))
      // Closed vaults keep their tabs for the next open (as `boostnote.tabs:<root>` does today).
      const remembered = Object.fromEntries(
        closed()
          .filter((vault) => views.has(vault.root))
          .map((vault) => [vault.name, viewOf(vault.root).tabs]),
      )
      if (variant === 'B')
        return {
          open: open.map((root) => vaultOf(root).name),
          selection: {
            vault: mixedSelection.root ? vaultOf(mixedSelection.root).name : 'all',
            folder: mixedSelection.folder,
          },
          tabs: mixedTabs.map((tab) => `${vaultOf(tab.root).name}:${tab.id}`),
          active: mixedActive ? `${vaultOf(mixedActive.root).name}:${mixedActive.id}` : null,
          remembered,
        }
      return {
        open: open.map((root) => vaultOf(root).name),
        [variant === 'C' ? 'focusedWindow' : 'active']: active ? vaultOf(active).name : null,
        perVault,
        remembered,
      }
    }

    return () => {
      const current = VARIANTS.find((item) => item.key === variant) ?? VARIANTS[0]
      const empty = open.length === 0 && variant !== 'C'
      return (
        <div mix={pageStyle}>
          {empty ? (
            <div mix={padStyle}>
              <p mix={muted}>No vault open.</p>
              {closed().map((vault) => (
                <button key={vault.root} type="button" mix={[rowStyle, on('click', () => openVault(vault.root))]}>
                  {dot(vault)} Open {vault.name}
                </button>
              ))}
            </div>
          ) : null}
          {variant === 'A' && !empty ? variantA() : null}
          {variant === 'B' && !empty ? variantB() : null}
          {variant === 'C' ? variantC() : null}
          <div mix={switcherStyle} data-prototype-switcher>
            <button type="button" mix={[switchArrowStyle, on('click', () => cycle(-1))]} aria-label="Previous variant">
              ‹
            </button>
            <span data-variant={current.key}>
              {current.key} ({current.name})
            </span>
            <button type="button" mix={[switchArrowStyle, on('click', () => cycle(1))]} aria-label="Next variant">
              ›
            </button>
            <details mix={stateStyle}>
              <summary>State</summary>
              <pre>{JSON.stringify(state(), null, 2)}</pre>
            </details>
          </div>
        </div>
      )
    }
  },
)

const pageStyle = css({ height: '100vh', overflow: 'hidden' })
const shellStyle = css({ display: 'grid', height: '100vh' })
const railGridStyle = css({ gridTemplateColumns: '56px 220px 260px minmax(0, 1fr)' })
const multiGridStyle = css({ gridTemplateColumns: '260px 280px minmax(0, 1fr)' })
const railStyle = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '8px',
  padding: '10px 0',
  background: 'var(--bg-statusbar)',
  borderRight: '1px solid var(--border)',
})
const railButtonStyle = css({
  position: 'relative',
  width: '36px',
  height: '36px',
  border: 0,
  borderRadius: '10px',
  color: '#fff',
  fontWeight: 700,
  fontSize: '12px',
  cursor: 'pointer',
  opacity: 0.6,
  '&[aria-pressed="true"]': { opacity: 1, outline: '2px solid var(--text)', outlineOffset: '2px' },
  '&:hover': { opacity: 1 },
})
const railAddStyle = css({ background: 'transparent', color: 'var(--text-muted)', border: '1px dashed var(--border)' })
const railBadgeStyle = css({
  position: 'absolute',
  right: '-4px',
  bottom: '-4px',
  minWidth: '16px',
  padding: '0 3px',
  borderRadius: '8px',
  background: 'var(--text)',
  color: 'var(--bg)',
  fontSize: '10px',
  lineHeight: '16px',
})
const sidebarStyle = css({
  minWidth: 0,
  padding: '8px',
  overflow: 'auto',
  background: 'var(--bg-sidebar)',
  borderRight: '1px solid var(--border)',
  userSelect: 'none',
})
const vaultHeaderStyle = css({
  display: 'flex',
  alignItems: 'center',
  padding: '6px 8px',
  marginBottom: '6px',
  fontWeight: 600,
})
const noteListStyle = css({
  minWidth: 0,
  overflow: 'auto',
  background: 'var(--bg-list)',
  borderRight: '1px solid var(--border)',
})
const editorStyle = css({
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  overflow: 'auto',
  background: 'var(--bg)',
})
const listStyle = css({ listStyle: 'none', margin: 0, padding: 0 })
const rowStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  width: '100%',
  padding: '3px 6px',
  border: 0,
  borderRadius: '6px',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  '&:hover': { background: 'var(--bg-hover)' },
  '&[data-selected]': { background: 'var(--bg-selected)' },
})
const noteRowStyle = css({
  display: 'grid',
  gap: '2px',
  width: '100%',
  padding: '8px 12px',
  border: 0,
  borderBottom: '1px solid var(--border)',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  '&:hover': { background: 'var(--bg-hover)' },
  '&[data-selected]': { background: 'var(--bg-selected)' },
})
const iconStyle = css({ width: '14px', flex: 'none', textAlign: 'center', color: 'var(--text-muted)' })
const labelStyle = css({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
const countStyle = css({ flex: 'none', fontSize: '11px', color: 'var(--text-muted)' })
const smallStyle = css({ fontSize: '12px' })
const padStyle = css({ padding: '12px' })
const dotStyle = css({ display: 'inline-block', width: '8px', height: '8px', flex: 'none', borderRadius: '50%' })
const sectionStyle = css({ marginTop: '10px' })
const sectionHeaderStyle = css({ display: 'flex', alignItems: 'center' })
const sectionToggleStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  flex: 1,
  minWidth: 0,
  padding: '4px 6px',
  border: 0,
  background: 'transparent',
  color: 'var(--text-muted)',
  cursor: 'pointer',
})
const tabStripStyle = css({
  display: 'flex',
  gap: '2px',
  minHeight: '32px',
  padding: '4px 4px 0',
  background: 'var(--bg-list)',
  borderBottom: '1px solid var(--border)',
  overflowX: 'auto',
})
const tabStyle = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '4px 10px',
  border: '1px solid transparent',
  borderBottom: 0,
  borderRadius: '6px 6px 0 0',
  background: 'transparent',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  '&[aria-pressed="true"]': { background: 'var(--bg)', borderColor: 'var(--border)' },
})
const editorBodyStyle = css({ padding: '16px 28px' })
const titleStyle = css({ margin: '4px 0 12px', fontSize: '22px' })
const bodyStyle = css({ margin: 0, font: 'inherit', whiteSpace: 'pre-wrap' })
const desktopStyle = css({
  position: 'relative',
  height: '100vh',
  overflow: 'hidden',
  background: 'linear-gradient(135deg, #3b4252, #1f2328)',
})
const menuBarStyle = css({
  position: 'relative',
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  gap: '18px',
  height: '28px',
  padding: '0 16px',
  background: 'rgba(30, 33, 36, 0.85)',
  color: '#e6e8eb',
  fontSize: '13px',
})
const menuAnchorStyle = css({ position: 'relative' })
const menuButtonStyle = css({
  padding: '2px 6px',
  border: 0,
  borderRadius: '4px',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  '&[aria-expanded="true"]': { background: 'rgba(255,255,255,0.15)' },
})
const menuStyle = css({
  position: 'absolute',
  top: '24px',
  left: 0,
  display: 'grid',
  minWidth: '260px',
  padding: '4px',
  borderRadius: '8px',
  background: 'var(--bg)',
  color: 'var(--text)',
  boxShadow: 'var(--shadow)',
})
const menuItemStyle = css({
  display: 'flex',
  gap: '6px',
  padding: '4px 8px',
  border: 0,
  borderRadius: '4px',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  '&:hover': { background: 'var(--accent)', color: '#fff' },
})
const checkStyle = css({ width: '14px' })
const menuRuleStyle = css({ width: '100%', margin: '4px 0', border: 0, borderTop: '1px solid var(--border)' })
const windowStyle = css({
  position: 'absolute',
  width: 'min(820px, 70vw)',
  height: 'min(520px, 62vh)',
  display: 'grid',
  gridTemplateRows: '28px minmax(0, 1fr)',
  overflow: 'hidden',
  borderRadius: '10px',
  border: '1px solid var(--border)',
  boxShadow: 'var(--shadow)',
  background: 'var(--bg)',
  opacity: 0.92,
  '&[data-focused]': { opacity: 1 },
})
const titleBarStyle = css({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '0 12px',
  background: 'var(--bg-statusbar)',
  borderBottom: '1px solid var(--border)',
})
const trafficStyle = css({
  width: '12px',
  height: '12px',
  padding: 0,
  border: 0,
  borderRadius: '50%',
  background: '#ff5f57',
  cursor: 'pointer',
})
const windowTitleStyle = css({ flex: 1, marginRight: '52px', textAlign: 'center', fontSize: '13px', fontWeight: 600 })
const miniGridStyle = css({ display: 'grid', gridTemplateColumns: '170px 220px minmax(0, 1fr)', minHeight: 0 })
const switcherStyle = css({
  position: 'fixed',
  bottom: '16px',
  left: '50%',
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '6px 10px',
  transform: 'translateX(-50%)',
  borderRadius: '999px',
  background: '#111',
  color: '#fff',
  fontSize: '13px',
  boxShadow: '0 6px 20px rgba(0,0,0,0.4)',
})
const switchArrowStyle = css({
  width: '24px',
  height: '24px',
  border: 0,
  borderRadius: '50%',
  background: '#333',
  color: '#fff',
  cursor: 'pointer',
})
const stateStyle = css({
  position: 'relative',
  '& > pre': {
    position: 'absolute',
    bottom: '28px',
    right: 0,
    width: '340px',
    maxHeight: '50vh',
    overflow: 'auto',
    margin: 0,
    padding: '10px',
    borderRadius: '8px',
    background: '#111',
    fontSize: '11px',
  },
})
