# Agent Runs

Start Claude Code from a story page to build or review that story, and follow the run from MyBMAD.

## Enabling

Agent runs only work for projects imported from a local folder (see [LOCAL_FOLDER.md](LOCAL_FOLDER.md)). In `.env`:

```
ENABLE_LOCAL_FS=true
ENABLE_AGENT_RUNS=true
```

Restart the server after changing these values. The `claude` CLI must be installed and signed in for the user that runs MyBMAD.

## How it works

The **Agents** card on a story page has two actions:

- **Start dev** runs `/bmad-build-auto` for the story.
- **Start review** runs `/bmad-code-review` for the story. With **Review fixes its findings** on, the review applies its fixes; off, it only reports them.

Each action has a model choice, pre-filled from the project's `story-complexity.md` (a table with a `Story` and a `Model` column):

- Dev uses the first model the row names (`Opus (core) · Haiku (theme)` → Opus).
- Review uses one tier higher (Haiku → Sonnet, Sonnet → Opus, Opus stays Opus).
- Without a row, dev uses Sonnet and review Opus.

A run is a detached `claude -p` process in the project folder. Its record, prompt and output are files in `.agent-runs/` (or `AGENT_RUNS_DIR`), so runs survive a restart of MyBMAD. The run page shows the log while it runs, the cost and turns when it ends, and a **Stop** button.

## Security

Agents run headless with `--permission-mode bypassPermissions`: they can run any command and change any file the MyBMAD server user can. Only the owner of a project can start runs for it. Set `AGENT_COMMAND_TEMPLATE` for a stricter command, for example with `--allowedTools`.
