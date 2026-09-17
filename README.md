# OpenCode Side Chat

A temporary, read-only side-chat panel for OpenCode V2.

> **Personal-use, vibecoded software.** This plugin was made for my own setup and is published as-is. Be careful: review the source, test it in a disposable session, and do not assume it is secure, stable, or suitable for your workflow.

## What it does

- Opens a side chat with `Alt+B`, `/side`, or `/mini`.
- Forks the current OpenCode session so the side chat gets its context.
- Keeps the side chat read-only.
- Uses a separate composer and transcript panel.
- Uses distinct colors for user, assistant, tool, and error output.
- Keeps side-chat tracking only in memory.
- `Alt+Enter` queues the full transcript in the main chat, closes the panel, and deletes the temporary fork.
- Closing OpenCode removes temporary side-chat forks that were created during that run.

## Install

This is built against OpenCode `2.0.5`.

```sh
git clone https://github.com/IamMistake/opencode-sidechat.git \
  ~/.config/opencode/plugins/mini-session
cd ~/.config/opencode/plugins/mini-session
npm install
```

Ensure the plugin is enabled in `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["local.mini-session"]
}
```

Restart OpenCode after installation or changes.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+B` | Open or reopen side chat |
| `Esc` | Close panel; keep it for this OpenCode run |
| `Alt+Enter` | Send transcript to main chat, close, and discard it |
| `Ctrl+Q` | Toggle queue/steer delivery |
| `Alt+F` | Toggle panel fullscreen |

## Commands

- `/side [prompt]`
- `/mini [prompt]`
- `/side-new [prompt]`
- `/side-send latest|all`
- `/side-discard`

## Development

```sh
npm install
npm run typecheck
```
