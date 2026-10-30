# Session Monitor

A Claude Code desktop mod: one pane listing every Code session as **Ongoing**, **Complete** or **Idle**, with latest activity, a projects view, a to-do list and an Open session button.

- Opens on session start, or run `/sessions`.
- Polls the app's session list every 10 s and toasts when a running session finishes.
- Falls back to clearly labeled demo rows when the session list can't be read.

## Notes

- `.claude-plugin/types/` holds generated SDK typings and is git-ignored; the app regenerates them.
- Open session uses `cmd /c start`, so it is Windows-only for now (it copies the link elsewhere).

## License

MIT, see [LICENSE](LICENSE).
