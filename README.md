# Session Monitor

A Claude Code desktop mod: one pane listing every Code session as **Ongoing**, **Complete** or **Idle**, with latest activity, a projects view, a to-do list and an Open session button.

- Opens on session start, or run `/sessions`.
- Polls the app's session list every 10 s.
- Notifications: when a running session finishes (and, if you turn it on, when one starts working), it shows a toast, a desktop notification and an entry under the bell, which counts what's unread. Clicking a Windows notification opens that session. Choose what you get in Settings, where you can also send a test notification.
- Falls back to clearly labeled demo rows when the session list can't be read.

## Notes

- `.claude-plugin/types/` holds generated SDK typings and is git-ignored; the app regenerates them.
- Open session uses `cmd /c start`, so it is Windows-only for now (it copies the link elsewhere).
- Desktop notifications go through your terminal's notification channel when it has one. The desktop app has none, so on Windows they are raised as Windows toasts through PowerShell; other systems get the toast and the bell only for now. With several sessions open, each event is notified once.

## License

MIT, see [LICENSE](LICENSE).
