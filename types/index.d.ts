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

/** A session that finished, or one that started working again. */
export type NoticeKind = 'finished' | 'started'

export type Notice = {
  id: string
  kind: NoticeKind
  sessionId: string
  title: string
  /** ms epoch when the monitor saw it happen. */
  at: number
  read: boolean
}

export type NotifyPrefs = {
  /** Notify when a session the monitor saw running stops. */
  finished: boolean
  /** Notify when an idle or complete session starts running again. */
  started: boolean
  /** Raise a system notification, not just the in-app toast. */
  desktop: boolean
  /** Show the small toast over the transcript. */
  toast: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'session-monitor': {
      sessions: Shaped<Session[]>
      source: Source
      selected: string
      filter: 'all' | 'ongoing' | 'complete'
      search: string
      view: 'sessions' | 'projects' | 'settings' | 'notifications'
      idleWithin: number
      todos: Shaped<Todo[]>
      navOrder: ('new' | 'sessions' | 'projects' | 'settings')[]
      theme: 'light' | 'dark'
      notices: Shaped<Notice[]>
      notifyPrefs: Shaped<NotifyPrefs>
    }
  }
}
