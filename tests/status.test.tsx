import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-monitor',
  component: 'Pane',
  requestId: 'session-monitor',
  surface: 'desktop',
  props: {
    title: 'Session monitor',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const row = (id: string, isRunning: boolean) => ({
  sessionId: id, title: `Task ${id}`, cwd: 'C:/p', isRunning,
  lastActivityAt: '2026-10-29T05:00:00.000Z', link: `claude://x/${id}`,
})

test('a session seen running then idle is Complete; one never seen running stays Idle', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let running = true
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', (_, e) => {
    const json = (v: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(v) }], isError: false } })
    if (e.tool === 'list_sessions') return json([row('a', running), row('b', false)])
    if (e.tool === 'get_session') return { value: { content: [], isError: true } }
    return { value: { content: [{ type: 'text', text: '[user] build it\n[assistant] (called mcp__x__Write)\n[assistant] Writing the project files\nmore detail' }], isError: false } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  let ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /● Ongoing/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Writing the project files/ })).toBeDefined()
  await ui.unmount()

  running = false
  await clock.advance(10_000)

  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /✓ Complete/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /○ Idle/ })).toBeDefined()
  expect(toasts).toEqual(['Session complete: Task a'])
  await ui.unmount()
})

test('when the app list cannot be read the pane says so and labels demo rows', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'no app' }], isError: true } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /Live session data unavailable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\(demo\)/ })).toBeDefined()
  await ui.unmount()
})

test('Dark in Settings repaints the pane', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.drawn()).toMatchObject({ props: { backgroundColor: '#FAF7F2' } })
  await ui.press({ key: 'nav-settings' })
  await ui.press({ key: 'theme-dark' })
  expect(await ui.drawn()).toMatchObject({ props: { backgroundColor: '#1C1B19' } })
  await ui.unmount()
})

test('a theme stored by an earlier session is drawn from the start', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { theme: 'dark' })
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  expect(await ui.drawn()).toMatchObject({ props: { backgroundColor: '#1C1B19' } })
  await ui.unmount()
})

test('a task typed into the To do field is listed and can be checked off', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: '[]' }], isError: false } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount(PANE)
  await ui.input({ key: 'todo-new', text: 'Ship the mod' })
  expect(await ui.find({ type: 'Text', text: /Ship the mod/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /☐/ })).toBeDefined()
  const toggle = await ui.find({ type: 'Button', text: /Ship the mod/ })
  if (toggle?.key) await ui.press({ key: toggle.key })
  expect(await ui.find({ type: 'Text', text: /☑/ })).toBeDefined()
  await ui.unmount()
})

const RAN = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
// The desktop app has no terminal channel, so a notification falls back to a Windows toast.
const NO_SURFACE = { isSent: false, reason: 'no-surface' } as const

test('a finished session is listed under the bell as unread and raises one Windows notification', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let running = true
  const runs: { argv: readonly string[]; env?: Record<string, string> }[] = []
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: NO_SURFACE }))
  on('process.run', (_, e) => { runs.push({ argv: e.argv, env: e.init?.env }); return { value: RAN } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'list_sessions') return { value: { content: [{ type: 'text', text: JSON.stringify([row('a', running)]) }], isError: false } }
    return { value: { content: [], isError: true } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(runs).toHaveLength(0)

  running = false
  await clock.advance(10_000)
  expect(runs).toHaveLength(1)
  expect(runs[0]?.argv[0]).toBe('powershell.exe')
  expect(runs[0]?.env).toMatchObject({ SM_TITLE: 'Session complete', SM_BODY: 'Task a', SM_LINK: 'claude://x/a' })

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'nav-notifications' }))?.text).toMatch(/1 new/)
  await ui.press({ key: 'nav-notifications' })
  expect(await ui.find({ type: 'Text', text: /Task a/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Session complete/ })).toBeDefined()
  await ui.press({ key: 'notices-read' })
  expect((await ui.find({ key: 'nav-notifications' }))?.text).not.toMatch(/new/)
  await ui.unmount()

  await clock.advance(10_000)
  expect(runs).toHaveLength(1)
})

test('start notices wait for Settings to turn them on, and with desktop off they stay in the bell', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  let running = false
  let runs = 0
  const toasts: string[] = []
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.notify', () => ({ value: NO_SURFACE }))
  on('process.run', () => { runs++; return { value: RAN } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'list_sessions') return { value: { content: [{ type: 'text', text: JSON.stringify([row('a', running)]) }], isError: false } }
    return { value: { content: [], isError: true } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  running = true
  await clock.advance(10_000)

  let ui = await $.ui.mount(PANE)
  await ui.press({ key: 'nav-notifications' })
  expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
  await ui.press({ key: 'nav-settings' })
  await ui.press({ key: 'notify-started' })
  await ui.press({ key: 'notify-desktop' })
  expect((await ui.find({ key: 'notify-started' }))?.text).toMatch(/☑/)
  expect((await ui.find({ key: 'notify-desktop' }))?.text).toMatch(/☐/)
  await ui.unmount()

  running = false
  await clock.advance(10_000)
  running = true
  await clock.advance(10_000)

  ui = await $.ui.mount(PANE)
  await ui.press({ key: 'nav-notifications' })
  expect(await ui.find({ type: 'Text', text: /Session complete/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Session started/ })).toBeDefined()
  expect((await ui.find({ key: 'nav-notifications' }))?.text).toMatch(/2 new/)
  await ui.unmount()
  expect(toasts).toEqual(['Session complete: Task a', 'Session started: Task a'])
  expect(runs).toBe(0)
})

test('an event another session already put in the inbox is not notified twice', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { notices: [{ id: 'other', kind: 'finished', sessionId: 'a', title: 'Task a', at: clock.now() + 10_000, read: false }] })
  let running = true
  let runs = 0
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: NO_SURFACE }))
  on('process.run', () => { runs++; return { value: RAN } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'list_sessions') return { value: { content: [{ type: 'text', text: JSON.stringify([row('a', running)]) }], isError: false } }
    return { value: { content: [], isError: true } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  running = false
  await clock.advance(10_000)

  expect(runs).toBe(0)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'nav-notifications' }))?.text).toMatch(/1 new/)
  await ui.unmount()
})
