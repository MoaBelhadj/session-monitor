export type Entry = { who: 'user' | 'assistant' | 'tool' | 'result' | 'system'; text: string }

export type Status = 'ongoing' | 'complete' | 'idle'

export type Session = {
  id: string
  title: string
  cwd: string
  link?: string
  isSelf?: boolean
  status: Status
  /** ISO time of the app's last activity record for the session. */
  lastActivityAt: string
  /** ms epoch when this mod saw the session stop running; the evidence for `complete`. */
  finishedAt?: number
  /** Last transcript lines, most recent last; read for ongoing and selected sessions only. */
  activity?: Entry[]
  isDemo?: boolean
}

export type Todo = { id: string; text: string; done: boolean }

export type Source = { kind: 'live'; at: number } | { kind: 'unavailable'; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'session-monitor': {
      sessions: Shaped<Session[]>
      source: Source
      selected: string
      filter: 'all' | 'ongoing' | 'complete'
      search: string
      view: 'sessions' | 'projects' | 'settings'
      idleWithin: number
      todos: Shaped<Todo[]>
      navOrder: ('new' | 'sessions' | 'projects' | 'settings')[]
      theme: 'light' | 'dark'
    }
  }
}
