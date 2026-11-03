import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, UiPressArgument } from 'claude-code'

import type { Entry, Notice, NoticeKind, NotifyPrefs, Session, Source, Status, Todo } from '../types'

const PANE = 'session-monitor'
const MCP = 'ccd_session_mgmt'
const POLL_MS = 10_000

const sessions = atom({ plugin: 'session-monitor', key: 'sessions' } as const, [] as Session[], { shape: 'sessions-2' })
const source = atom({ plugin: 'session-monitor', key: 'source' } as const, { kind: 'unavailable', reason: 'not polled yet' } as Source)
const selected = atom({ plugin: 'session-monitor', key: 'selected' } as const, '')
const filter = atom({ plugin: 'session-monitor', key: 'filter' } as const, 'all' as 'all' | 'ongoing' | 'complete')
const search = atom({ plugin: 'session-monitor', key: 'search' } as const, '')
type ViewId = 'sessions' | 'projects' | 'settings' | 'notifications'
const view = atom({ plugin: 'session-monitor', key: 'view' } as const, 'sessions' as ViewId)
// Idle sessions older than this many minutes are hidden from the list; 0 shows all.
const idleWithin = atom({ plugin: 'session-monitor', key: 'idleWithin' } as const, 1440)
const todos = atom({ plugin: 'session-monitor', key: 'todos' } as const, [] as Todo[], { shape: 'todos-1' })
type NavId = 'new' | 'sessions' | 'projects' | 'settings'
const NAV_LABEL: Record<NavId, string> = { new: 'New chat', sessions: 'Session monitor', projects: 'Projects', settings: 'Settings' }
const navOrder = atom({ plugin: 'session-monitor', key: 'navOrder' } as const, ['new', 'sessions', 'projects', 'settings'] as NavId[])
// The engine does not tell a pane the app's light/dark mode, so the person picks it.
const theme = atom({ plugin: 'session-monitor', key: 'theme' } as const, 'light' as 'light' | 'dark')
// Notifications: the inbox the bell opens (newest first, kept in the store so every
// session's monitor shows the same one) and what to notify about.
const notices = atom({ plugin: 'session-monitor', key: 'notices' } as const, [] as Notice[], { shape: 'notices-1' })
const DEFAULT_PREFS: NotifyPrefs = { finished: true, started: false, desktop: true, toast: true }
const notifyPrefs = atom({ plugin: 'session-monitor', key: 'notifyPrefs' } as const, DEFAULT_PREFS, { shape: 'notify-1' })
const MAX_NOTICES = 50
// Every open session runs its own monitor. One that sees an event another already
// put in the inbox this close in time leaves the desktop notification to that one.
const SAME_EVENT_MS = 60_000
const PREF_LABEL: Record<keyof NotifyPrefs, string> = {
  finished: 'When a session finishes', started: 'When a session starts working',
  desktop: 'Desktop notifications', toast: 'In-app toasts',
}
const HEAD: Record<NoticeKind, string> = { finished: 'Session complete', started: 'Session started' }
// The desktop app has no terminal to notify through, so on Windows the toast is raised
// with PowerShell. The script is fixed; the text arrives in environment variables and
// is escaped for XML inside it, so a session title cannot change what runs. Clicking
// the toast opens SM_LINK, the session's own claude:// link.
const TOAST_PS = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
function Esc([string]$s) { [Security.SecurityElement]::Escape($s) }
$open = ''
if ($env:SM_LINK) { $open = " activationType='protocol' launch='" + (Esc $env:SM_LINK) + "'" }
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast$open><visual><binding template='ToastGeneric'><text>" + (Esc $env:SM_TITLE) + "</text><text>" + (Esc $env:SM_BODY) + "</text></binding></visual></toast>")
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`
// -EncodedCommand takes the script as base64 UTF-16LE, so no quoting reaches the shell.
const utf16le = (s: string) => Array.from(s, c => String.fromCharCode(c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8)).join('')
const TOAST_ARGV = ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', btoa(utf16le(TOAST_PS))]
const WHO: Record<Entry['who'], string> = { user: 'You', assistant: 'Claude', tool: 'Tool', result: 'Result', system: 'System' }
const IDLE_CHOICES = [{ m: 60, label: 'Last hour' }, { m: 1440, label: 'Last day' }, { m: 10080, label: 'Last week' }, { m: 0, label: 'All' }]

// Reference palette: warm ivory, charcoal, terracotta, green; dark is the same hues on warm charcoal.
const PALETTE = {
  light: {
    bg: '#FAF7F2', panel: '#FFFFFF', text: '#2B2A28', muted: '#6F6A63', border: '#E6E0D6',
    accent: '#C8613F', accentBg: '#F9EDE7', green: '#2E7D4F', greenBg: '#E8F3EC', idle: '#9A948B', sand: '#E9B78E',
  },
  dark: {
    bg: '#1C1B19', panel: '#262523', text: '#ECE7DF', muted: '#A8A198', border: '#3A3734',
    accent: '#E27D5A', accentBg: '#3B2820', green: '#5FB585', greenBg: '#1F3328', idle: '#857F77', sand: '#B9835A',
  },
}
type Palette = typeof PALETTE.light
// Pane backdrop: glowing blobs, a dot grid, contour waves and a faint ✱. Tall so it
// scales to the pane's width and still covers long content; the rest is C.bg.
const WAVE = 'M-40 0C160-70 320 90 520 20S880-60 1240 30'
const backdrop = (C: Palette) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 3000" width="1200" height="3000">
<defs>
<radialGradient id="a"><stop offset="0" stop-color="${C.accent}" stop-opacity=".28"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
<radialGradient id="g"><stop offset="0" stop-color="${C.green}" stop-opacity=".18"/><stop offset="1" stop-color="${C.green}" stop-opacity="0"/></radialGradient>
<radialGradient id="s"><stop offset="0" stop-color="${C.sand}" stop-opacity=".35"/><stop offset="1" stop-color="${C.sand}" stop-opacity="0"/></radialGradient>
<pattern id="d" width="44" height="44" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="2.6" fill="${C.text}" fill-opacity=".07"/></pattern>
<path id="w" d="${WAVE}" fill="none" stroke-width="4.5"/>
</defs>
<rect width="1200" height="3000" fill="${C.bg}"/>
<rect width="1200" height="3000" fill="url(#d)"/>
<circle cx="1080" cy="80" r="620" fill="url(#a)"/>
<circle cx="60" cy="1150" r="680" fill="url(#g)"/>
<circle cx="980" cy="2100" r="720" fill="url(#s)"/>
<circle cx="200" cy="2850" r="600" fill="url(#a)"/>
<g stroke="${C.accent}" stroke-opacity=".2">${[0, 1, 2, 3, 4, 5].map(i => `<use href="#w" y="${420 + i * 34}"/>`).join('')}</g>
<g stroke="${C.green}" stroke-opacity=".16">${[0, 1, 2, 3, 4].map(i => `<use href="#w" y="${1700 + i * 40}"/>`).join('')}</g>
<g transform="translate(1040 150)" stroke="${C.accent}" stroke-opacity=".16" stroke-width="22" stroke-linecap="round"><path d="M0-110V110M-95-55L95 55M-95 55L95-55"/></g>
</svg>`
const labels = (C: Palette): Record<Status, { icon: string; text: string; color: string; bg: string }> => ({
  ongoing: { icon: '●', text: 'Ongoing', color: C.accent, bg: C.accentBg },
  complete: { icon: '✓', text: 'Complete', color: C.green, bg: C.greenBg },
  idle: { icon: '○', text: 'Idle', color: C.idle, bg: C.border },
})

// Shown only when the app's session list cannot be read; every row says so.
const DEMO: Session[] = [
  { id: 'demo-1', title: 'Build portfolio website (demo)', cwd: 'demo', status: 'ongoing', lastActivityAt: new Date().toISOString(), isDemo: true },
  { id: 'demo-2', title: 'Summarize meeting notes (demo)', cwd: 'demo', status: 'idle', lastActivityAt: new Date(Date.now() - 180_000).toISOString(), isDemo: true },
]

const ago = (iso: string | number, now: number) => {
  const m = Math.max(0, Math.round((now - (typeof iso === 'number' ? iso : Date.parse(iso))) / 60_000))
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} d ago`
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')

type Row = { sessionId: string; title?: string; cwd?: string; isRunning?: boolean; lastActivityAt?: string; link?: string }

// One transcript message per entry: "[who] text", continuation lines joined; a
// "(called mcp__server__tool)" line becomes a tool entry naming the tool.
function parseTranscript(raw: string): Entry[] {
  const out: Entry[] = []
  for (const line of raw.split('\n')) {
    const m = /^\[(user|assistant|result|tool|system)\]\s*(.*)$/.exec(line)
    if (m) {
      const called = /^\(called (?:mcp__\w+__)?(\w+)\)/.exec(m[2] ?? '')
      out.push(called ? { who: 'tool', text: `Used ${called[1]}` } : { who: m[1] as Entry['who'], text: m[2] ?? '' })
    } else if (out.length && line.trim()) {
      const last = out[out.length - 1]!
      if (last.text.length < 300) last.text += ' ' + line.trim()
    }
  }
  return out.filter(e => e.text).map(e => ({ ...e, text: e.text.replace(/[*`#_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160) })).slice(-4)
}

async function activity($: EngineInterface, id: string): Promise<Entry[] | undefined> {
  try {
    const r = await $.mcp.call(MCP, 'list_events', { session_id: id, limit: 6 })
    return r.isError ? undefined : parseTranscript(text(r))
  } catch {
    return undefined
  }
}

// Changes the inbox as it stands in the store, so another session's additions are kept.
async function setNotices($: EngineInterface, fn: (list: Notice[]) => Notice[]) {
  const kept = await $.store.get('notices')
  const next = fn(Array.isArray(kept) ? (kept as Notice[]) : await read($, notices))
  await $.store.set('notices', next)
  return update($, notices, () => next)
}

// Puts fresh events in the inbox and returns the ones no other session's monitor put
// there first: those are this monitor's to send as desktop notifications.
async function record($: EngineInterface, fresh: Notice[]): Promise<Notice[]> {
  const kept = await $.store.get('notices')
  const list = Array.isArray(kept) ? (kept as Notice[]) : await read($, notices)
  const added = fresh.filter(n => !list.some(o => o.kind === n.kind && o.sessionId === n.sessionId && Math.abs(o.at - n.at) < SAME_EVENT_MS))
  const next = added.length ? [...added, ...list].slice(0, MAX_NOTICES) : list
  if (added.length) await $.store.set('notices', next)
  await update($, notices, () => next)
  return added
}

// The person's terminal notification channel when there is one; otherwise (the desktop
// app has none) a Windows toast. Resolves whether either one sent it.
async function desktopNotify($: EngineInterface, head: string, body: string, link?: string): Promise<boolean> {
  const sent = await $.ui.notify(body, { title: head }).catch(() => undefined)
  if (sent?.isSent) return true
  // Notifications turned off in Claude Code settings, or refused by a hook: respect it.
  if (sent && (sent.reason === 'disabled' || sent.reason === 'refused')) return false
  // shortcut: Windows only (PowerShell toast); add osascript / notify-send when the mod runs elsewhere
  const ran = await $.process.run(TOAST_ARGV, { env: { SM_TITLE: head, SM_BODY: body, SM_LINK: link ?? '' }, timeoutMs: 20_000 }).catch(() => undefined)
  return ran?.exitCode === 0
}

async function announce($: EngineInterface, events: { kind: NoticeKind; s: Session }[], now: number) {
  const prefs = await read($, notifyPrefs)
  const fresh = events.filter(e => prefs[e.kind]).map(({ kind, s }): Notice => ({
    id: `${kind}-${s.id}-${now}`, kind, sessionId: s.id, title: s.title, at: now, read: false,
  }))
  const added = await record($, fresh)
  if (prefs.toast) for (const n of fresh) $.ui.toast(`${HEAD[n.kind]}: ${n.title}`, { timeoutMs: 6000 })
  if (prefs.desktop) {
    await Promise.all(added.map(n => desktopNotify($, HEAD[n.kind], n.title, events.find(e => e.s.id === n.sessionId)?.s.link)))
  }
}

async function testNotify($: EngineInterface) {
  const ok = await desktopNotify($, 'Session monitor', 'Notifications are on. You will get one like this when a session finishes.')
  $.ui.toast(ok
    ? 'Test notification sent. Not seeing it? Check Do not disturb, and that Windows PowerShell may notify in Windows Settings > Notifications.'
    : 'No desktop notification could be sent from here.', { timeoutMs: 8000 })
}

async function poll($: EngineInterface) {
  const now = await $.clock.now()
  let rows: Row[]
  let self: Row | undefined
  try {
    const r = await $.mcp.call(MCP, 'list_sessions', { limit: 50 })
    if (r.isError) throw new Error(text(r))
    rows = JSON.parse(text(r)) as Row[]
    const s = await $.mcp.call(MCP, 'get_session', { session_id: 'self' })
    if (!s.isError) self = JSON.parse(text(s)) as Row
  } catch (err) {
    await update($, source, (): Source => ({ kind: 'unavailable', reason: String(err instanceof Error ? err.message : err) }))
    await update($, sessions, list => (list.some(s => !s.isDemo) ? list : DEMO))
    return
  }
  const prev = await read($, sessions)
  const sel = await read($, selected)
  const merged: Session[] = []
  const events: { kind: NoticeKind; s: Session }[] = []
  for (const row of [self, ...rows]) {
    if (!row?.sessionId) continue
    const old = prev.find(s => s.id === row.sessionId)
    let status: Status = row.isRunning ? 'ongoing' : old?.status === 'ongoing' ? 'complete' : (old?.status ?? 'idle')
    const finishedAt = status === 'complete' ? (old?.finishedAt ?? now) : undefined
    const s: Session = {
      id: row.sessionId, title: row.title ?? '(untitled)', cwd: row.cwd ?? '', link: row.link,
      isSelf: row === self, status, lastActivityAt: row.lastActivityAt ?? '', finishedAt, activity: old?.activity,
    }
    if (old?.status === 'ongoing' && status === 'complete') events.push({ kind: 'finished', s })
    // Seen stopped on an earlier poll, so not one the first poll found already running;
    // this session starts whenever the person sends it a message, so it is left out.
    if (old && old.status !== 'ongoing' && status === 'ongoing' && row !== self) events.push({ kind: 'started', s })
    if (status === 'ongoing' || s.id === sel) s.activity = (await activity($, s.id)) ?? s.activity
    merged.push(s)
  }
  await update($, sessions, () => merged)
  await update($, source, (): Source => ({ kind: 'live', at: now }))
  // Called with no events too: it picks up what other sessions' monitors added.
  await announce($, events, now)
}

// The pane draws no claude:// Link and the app's focus call refuses sessions this
// one did not start, so the app's own deep link is opened through the shell.
async function openSession($: EngineInterface, s: Session, surface: UiPressArgument['surface']) {
  if (!s.link) return $.ui.toast('No app link for this session: open it from the sidebar.')
  // shortcut: Windows only (cmd start); add xdg-open / open when the mod runs elsewhere
  const ran = await $.process.run(['cmd', '/c', 'start', '', s.link]).catch(() => undefined)
  if (ran && ran.exitCode === 0) return
  const copied = await $.ui.copy({ text: s.link, surface })
  $.ui.toast(copied.isCopied ? `Link copied: paste it in a browser, or click "${s.title}" in the sidebar.` : `Open "${s.title}" from the sidebar.`, { timeoutMs: 6000 })
}

async function setTodos($: EngineInterface, fn: (list: Todo[]) => Todo[]) {
  const next = await update($, todos, fn)
  await $.store.set('todos', next)
}

// The app starts a session only with a task brief, so the new chat greets and waits.
async function newChat($: EngineInterface) {
  const r = await $.mcp.call('ccd_session', 'start_session', {
    initiation: 'user_asked', title: 'New chat', context: 'fresh', use_worktree: false,
    prompt: 'Say hello in one short line and wait for my message. Do nothing else.',
    background: 'The user pressed New chat in their Session Monitor pane. This is a blank conversation: there is no task yet, so greet briefly and wait for what they want to do next.',
  }).catch(() => undefined)
  $.ui.toast(r && !r.isError ? 'New chat started: see the sidebar.' : 'Could not start a new chat: use New session in the app sidebar.')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sessions', description: 'Open the Session Monitor pane' })
    void $.ui.open({ id: PANE, title: 'Session monitor' })
    const kept = await $.store.get('todos')
    if (Array.isArray(kept)) await update($, todos, () => kept as Todo[])
    const order = await $.store.get('navOrder')
    if (Array.isArray(order) && order.length === 4) await update($, navOrder, () => order as NavId[])
    const look = await $.store.get('theme')
    if (look === 'light' || look === 'dark') await update($, theme, () => look)
    const prefs = await $.store.get('notifyPrefs')
    if (prefs && typeof prefs === 'object') await update($, notifyPrefs, () => ({ ...DEFAULT_PREFS, ...(prefs as Partial<NotifyPrefs>) }))
    const inbox = await $.store.get('notices')
    if (Array.isArray(inbox)) await update($, notices, () => inbox as Notice[])
    void poll($)
    $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Session monitor', focus: true })
    void poll($)
    return { text: 'Session monitor opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // shortcut: the mobile table draws no Input, so search is a desktop/terminal/vscode feature; revisit when mobile gets one
    const Input = 'Input' in els ? els.Input : undefined
    // The terminal table draws no Svg, so it keeps the flat C.bg.
    const Svg = 'Svg' in els ? els.Svg : undefined
    const [list, src, sel, flt, q, v, idleMin, tasks, order, look, inbox, prefs, now] = await Promise.all([
      read($, sessions), read($, source), read($, selected), read($, filter), read($, search), read($, view), read($, idleWithin), read($, todos), read($, navOrder), read($, theme),
      read($, notices), read($, notifyPrefs), $.clock.now(),
    ])
    const C = PALETTE[look]
    const unread = inbox.filter(n => !n.read).length
    const togglePref = (k: keyof NotifyPrefs) => update($, notifyPrefs, p => {
      const n = { ...p, [k]: !p[k] }
      void $.store.set('notifyPrefs', n)
      return n
    })
    const openNotice = async (n: Notice) => {
      await setNotices($, l => l.map(x => (x.id === n.id ? { ...x, read: true } : x)))
      await update($, selected, () => n.sessionId)
      return update($, view, () => 'sessions')
    }
    const LABEL = labels(C)
    const counts = { ongoing: list.filter(s => s.status === 'ongoing').length, complete: list.filter(s => s.status === 'complete').length }
    const shown = list
      .filter(s => s.status !== 'idle' || !idleMin || now - Date.parse(s.lastActivityAt) <= idleMin * 60_000)
      .filter(s => flt === 'all' || s.status === flt)
      .filter(s => !q || s.title.toLowerCase().includes(q.toLowerCase()))
    const cur = list.find(s => s.id === sel) ?? shown[0]

    const Badge = ({ status }: { status: Status }) => {
      const l = LABEL[status]
      return (
        <Box backgroundColor={l.bg} paddingX="sm">
          <Text color={l.color} weight="medium">{l.icon} {l.text}</Text>
        </Box>
      )
    }
    const Nav = ({ id }: { id: NavId }) => (
      <Button key={`nav-${id}`} plain variant={v === id ? 'primary' : 'secondary'}
        onPress={() => (id === 'new' ? void newChat($) : void update($, view, () => id))}>
        {NAV_LABEL[id]}
      </Button>
    )
    const move = (id: NavId, by: -1 | 1) => update($, navOrder, o => {
      const i = o.indexOf(id), j = i + by
      if (i < 0 || j < 0 || j >= o.length) return o
      const n = [...o]; n[i] = o[j] as NavId; n[j] = id
      void $.store.set('navOrder', n)
      return n
    })
    const Chip = ({ id, label, n }: { id: typeof flt; label: string; n: number }) => (
      <Button key={`flt-${id}`} variant={flt === id ? 'primary' : 'secondary'} onPress={() => update($, filter, () => id)}>
        {label} <Text dimColor>{n}</Text>
      </Button>
    )

    return (
      <Box flexDirection="column" backgroundColor={C.bg} padding="md" gap="md">
        {Svg && (
          <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
            <Svg source={backdrop(C)} alt="" />
          </Box>
        )}
        <Box flexDirection="row" gap="md" alignItems="center" flexWrap="wrap">
          <Text color={C.accent} size="heading" weight="bold">✱ Claude</Text>
          {order.map(id => <Nav id={id} />)}
          <Button key="nav-notifications" plain variant={v === 'notifications' ? 'primary' : 'secondary'}
            onPress={() => update($, view, () => 'notifications')}>
            🔔{unread ? <Text color={C.accent} weight="bold"> {unread} new</Text> : ''}
          </Button>
        </Box>

        {v === 'notifications' && (
          <Box flexDirection="column" gap="sm">
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap="sm">
              <Box flexDirection="column">
                <Text color={C.text} size="title" weight="bold">Notifications</Text>
                <Text color={C.muted} wrap="wrap">{unread ? `${unread} unread` : 'All caught up.'}</Text>
              </Box>
              {inbox.length > 0 && (
                <Box flexDirection="row" gap="sm">
                  {unread > 0 && <Button key="notices-read" onPress={() => setNotices($, l => l.map(n => ({ ...n, read: true })))}>Mark all read</Button>}
                  <Button key="notices-clear" onPress={() => setNotices($, () => [])}>Clear</Button>
                </Box>
              )}
            </Box>
            <Box flexDirection="column" backgroundColor={C.panel} borderStyle="round" borderColor={C.border}>
              {inbox.length === 0 && (
                <Box padding="md">
                  <Text color={C.muted} wrap="wrap">Nothing yet. When a session finishes it shows up here{prefs.desktop ? ' and as a desktop notification' : ''}.</Text>
                </Box>
              )}
              {inbox.map(n => (
                <Box key={`notice-${n.id}`} flexDirection="row" alignItems="center" gap="md" paddingX="md" paddingY="xs"
                  backgroundColor={n.read ? undefined : C.accentBg} hover={{ backgroundColor: C.bg }}>
                  <Box flexGrow={1} flexDirection="column" minWidth={0} overflow="hidden">
                    <Button key={`notice-open-${n.id}`} plain onPress={() => openNotice(n)}>
                      <Text color={n.kind === 'finished' ? C.green : C.accent} weight="bold">{n.kind === 'finished' ? '✓' : '●'}</Text>{' '}
                      <Text color={C.text} weight={n.read ? undefined : 'semibold'} wrap="truncate-end">{n.title}</Text>
                      {'\n'}
                      <Text color={C.muted} size="footnote">{HEAD[n.kind]} · {ago(n.at, now)}</Text>
                    </Button>
                  </Box>
                  {!n.read && <Text color={C.accent}>● new</Text>}
                </Box>
              ))}
            </Box>
          </Box>
        )}

        {v === 'settings' && (
          <Box flexDirection="column" gap="sm" backgroundColor={C.panel} borderStyle="round" borderColor={C.border} padding="md" minWidth={0} overflow="hidden">
            <Text color={C.text} size="heading" weight="semibold">Settings</Text>
            <Text color={C.text} weight="semibold">Theme</Text>
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              {(['light', 'dark'] as const).map(t => (
                <Button key={`theme-${t}`} variant={look === t ? 'primary' : 'secondary'}
                  onPress={() => { void $.store.set('theme', t); return update($, theme, () => t) }}>
                  {t === 'light' ? '☀ Light' : '☾ Dark'}
                </Button>
              ))}
            </Box>
            <Text color={C.text} weight="semibold">Notifications</Text>
            <Box flexDirection="column" gap="xs">
              {(['finished', 'started', 'desktop', 'toast'] as const).map(k => (
                <Button key={`notify-${k}`} plain onPress={() => togglePref(k)}>
                  <Text color={prefs[k] ? C.green : C.muted}>{prefs[k] ? '☑' : '☐'}</Text> <Text color={C.text}>{PREF_LABEL[k]}</Text>
                </Button>
              ))}
            </Box>
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              <Button key="notify-test" onPress={() => void testNotify($)}>Send a test notification</Button>
            </Box>
            <Text color={C.muted} size="footnote" wrap="wrap">Desktop notifications use your terminal when it can show them. In the desktop app on Windows they are Windows notifications, and clicking one opens that session.</Text>
            <Text color={C.text} weight="semibold">Menu order</Text>
            <Text color={C.muted} size="footnote" wrap="wrap">Top to bottom here is left to right in the menu.</Text>
            <Box flexDirection="column" backgroundColor={C.bg} borderStyle="round" borderColor={C.border}>
              {order.map((id, i) => (
                <Box key={`ord-${id}`} flexDirection="row" gap="md" alignItems="center" paddingX="md" paddingY="xs" justifyContent="space-between">
                  <Text color={C.text}><Text color={C.muted} tabular wrap="wrap">{i + 1}.</Text> {NAV_LABEL[id]}</Text>
                  <Box flexDirection="row" gap="sm">
                    {i > 0 && <Button key={`ord-up-${id}`} onPress={() => void move(id, -1)}>Move up</Button>}
                    {i < order.length - 1 && <Button key={`ord-down-${id}`} onPress={() => void move(id, 1)}>Move down</Button>}
                  </Box>
                </Box>
              ))}
            </Box>
            <Text color={C.text}>Show idle sessions from</Text>
            <Box flexDirection="row" gap="sm" flexWrap="wrap">
              {IDLE_CHOICES.map(c => (
                <Button key={`idle-${c.m}`} variant={idleMin === c.m ? 'primary' : 'secondary'} onPress={() => update($, idleWithin, () => c.m)}>{c.label}</Button>
              ))}
            </Box>
            <Text color={C.muted} size="footnote" wrap="wrap">Refreshes every {POLL_MS / 1000} s. Complete means the monitor saw the session finish; a session idle since before that stays Idle.</Text>
            <Text color={C.muted} size="footnote" wrap="wrap">Source: {src.kind === 'live' ? `live, read ${ago(src.at, now)}` : `unavailable (${src.reason}); rows are labeled demo data`}</Text>
          </Box>
        )}

        {v === 'projects' && (
          <Box flexDirection="column" gap="sm">
            <Text color={C.text} size="title" weight="bold">Projects</Text>
            {[...new Set(list.map(s => s.cwd))].map(cwd => (
              <Box flexDirection="column" backgroundColor={C.panel} borderStyle="round" borderColor={C.border} padding="sm" minWidth={0} overflow="hidden">
                <Text color={C.text} weight="semibold" wrap="truncate-start">{cwd || '(no folder)'}</Text>
                {list.filter(s => s.cwd === cwd).map(s => (
                  <Text color={C.muted} size="footnote" wrap="wrap">{LABEL[s.status].icon} {s.title}</Text>
                ))}
              </Box>
            ))}
          </Box>
        )}

        {v === 'sessions' && (
          <Box flexDirection="column" gap="md">
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap="sm">
              <Box flexDirection="column">
                <Text color={C.text} size="title" weight="bold">All sessions</Text>
                <Text color={C.muted} wrap="wrap">Every conversation. One clear view.</Text>
              </Box>
              <Box flexDirection="row" gap="sm">
                <Box backgroundColor={C.panel} borderStyle="round" borderColor={C.border} paddingX="md">
                  <Text color={C.accent} weight="bold">● {counts.ongoing}</Text><Text color={C.muted} wrap="wrap"> Ongoing</Text>
                </Box>
                <Box backgroundColor={C.panel} borderStyle="round" borderColor={C.border} paddingX="md">
                  <Text color={C.green} weight="bold">✓ {counts.complete}</Text><Text color={C.muted} wrap="wrap"> Complete</Text>
                </Box>
              </Box>
            </Box>

            {src.kind === 'unavailable' && (
              <Box backgroundColor={C.accentBg} padding="sm" minWidth={0} overflow="hidden">
                <Text color={C.accent}>Live session data unavailable: {src.reason}. Showing labeled demo data.</Text>
              </Box>
            )}

            <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap">
              <Chip id="all" label="All" n={list.length} />
              <Chip id="ongoing" label="Ongoing" n={counts.ongoing} />
              <Chip id="complete" label="Complete" n={counts.complete} />
              {Input && (
                <Input key="search" placeholder="Search sessions..." value={q} submitLabel="search"
                  onInput={(val: string) => update($, search, () => val)} onSubmit={(val: string) => update($, search, () => val)} />
              )}
            </Box>

            <Box flexDirection="column" backgroundColor={C.panel} borderStyle="round" borderColor={C.border}>
              {shown.length === 0 && <Box padding="md"><Text color={C.muted} wrap="wrap">No sessions match.</Text></Box>}
              {shown.map(s => {
                const latest = s.activity?.at(-1)
                const l = LABEL[s.status]
                const when = s.status === 'complete' && s.finishedAt ? ago(s.finishedAt, now) : ago(s.lastActivityAt, now)
                const pick = () => update($, selected, () => s.id)
                // Non-breaking padding stretches each text button across the column; truncate-end clips the excess.
                const fill = ' '.repeat(240)
                // A Button holds only text, so each piece of the row is its own plain Button with the same press.
                return (
                  <Box key={`row-${s.id}`} flexDirection="row" alignItems="center" gap="md" paddingX="md" paddingY="xs"
                    backgroundColor={cur?.id === s.id ? C.accentBg : undefined} hover={{ backgroundColor: C.bg }}>
                    <Box flexGrow={1} flexDirection="column" minWidth={0} overflow="hidden">
                      <Button key={`sel-${s.id}`} plain onPress={pick}>
                        <Text color={C.text} weight="medium" wrap="truncate-end">{s.title}{s.isSelf ? ' (this session)' : ''}{s.isDemo ? ' demo' : ''}{fill}</Text>
                        {'\n'}
                        <Text color={C.muted} size="footnote" wrap="truncate-end">{latest ? `${WHO[latest.who]}: ${latest.text}` : 'No activity read'}{fill}</Text>
                      </Button>
                    </Box>
                    <Button key={`sel-badge-${s.id}`} plain onPress={pick}>
                      <Text color={l.color} backgroundColor={l.bg} weight="medium"> {l.icon} {l.text} </Text>
                    </Button>
                    <Button key={`sel-when-${s.id}`} plain onPress={pick}>
                      <Text color={C.muted} size="footnote" tabular>{when}</Text>
                    </Button>
                  </Box>
                )
              })}
            </Box>

            {cur && (
              <Box flexDirection="column" gap="sm" backgroundColor={C.panel} borderStyle="round" borderColor={C.border} padding="md" minWidth={0} overflow="hidden">
                <Text color={C.text} size="heading" weight="semibold">{cur.title}</Text>
                <Badge status={cur.status} />
                <Text color={C.muted} size="footnote" wrap="wrap">Latest activity</Text>
                {cur.activity?.at(-1) ? (
                  <Box flexDirection="column" backgroundColor={C.bg} borderStyle="round" borderColor={C.border} padding="sm" minWidth={0} overflow="hidden">
                    <Text color={C.accent} size="footnote" weight="semibold">{WHO[cur.activity.at(-1)!.who]}</Text>
                    <Text color={C.text} wrap="wrap">{cur.activity.at(-1)!.text}</Text>
                  </Box>
                ) : (
                  <Text color={C.muted} wrap="wrap">{cur.status === 'ongoing' ? 'Reading the transcript...' : 'Nothing read yet. The transcript loads on the next refresh.'}</Text>
                )}
                {(cur.activity?.length ?? 0) > 1 && <Text color={C.muted} size="footnote" wrap="wrap">Recent activity</Text>}
                {(cur.activity ?? []).slice(0, -1).map((e, i, all) => (
                  <Box key={`act-${cur.id}-${i}`} flexDirection="row" gap="sm" minWidth={0} overflow="hidden">
                    <Text color={i === all.length - 1 ? C.accent : C.idle}>{i === all.length - 1 ? '●' : '○'}</Text>
                    <Box flexDirection="column" flexGrow={1} minWidth={0}>
                      <Text color={C.text} size="footnote" weight="medium">{WHO[e.who]}</Text>
                      <Text color={C.muted} size="footnote" wrap="wrap">{e.text}</Text>
                    </Box>
                  </Box>
                ))}
                <Text color={C.muted} size="footnote" wrap="truncate-start">{cur.cwd}</Text>
                {cur.isSelf ? (
                  <Text color={C.muted} wrap="wrap">This is the current session.</Text>
                ) : (
                  <Button key={`open-${cur.id}`} variant="primary" onPress={press => void openSession($, cur, press.surface)}>↗ Open session</Button>
                )}
              </Box>
            )}

            <Box flexDirection="column" gap="sm" backgroundColor={C.panel} borderStyle="round" borderColor={C.border} padding="md" minWidth={0} overflow="hidden">
              <Text color={C.text} size="heading" weight="semibold">To do</Text>
              {tasks.length === 0 && <Text color={C.muted} wrap="wrap">Nothing yet. Add a task below.</Text>}
              {tasks.map(t => (
                <Box key={`todo-${t.id}`} flexDirection="row" gap="sm" alignItems="center">
                  <Button key={`todo-toggle-${t.id}`} plain onPress={() => void setTodos($, l => l.map(x => (x.id === t.id ? { ...x, done: !x.done } : x)))}>
                    <Text color={t.done ? C.green : C.muted}>{t.done ? '☑' : '☐'}</Text> <Text color={t.done ? C.muted : C.text} strikethrough={t.done}>{t.text}</Text>
                  </Button>
                  <Button key={`todo-remove-${t.id}`} plain dimColor onPress={() => void setTodos($, l => l.filter(x => x.id !== t.id))}>✕ remove</Button>
                </Box>
              ))}
              {Input && (
                <Input key="todo-new" placeholder="Add a task and press Enter" submitLabel="add"
                  onSubmit={(val: string) => { const text = val.trim(); if (text) void setTodos($, l => [...l, { id: `${Date.now()}`, text, done: false }]) }} />
              )}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
