# Agent Runs

Start Claude Code from a story page to build or review that story, and follow the run from MyBMAD.

## Enabling

Agent runs only work for projects imported from a local folder (see [LOCAL_FOLDER.md](LOCAL_FOLDER.md)). In `.env`:

```
ENABLE_LOCAL_FS=true
ENABLE_AGENT_RUNS=true
```

Restart the server after changing these values. The `claude` CLI must be installed and signed in for the user that runs MyBMAD.

### Claude accounts

Claude Code keeps each account's sign-in with its config folder (`CLAUDE_CONFIG_DIR`). A `claude` signed in with `CLAUDE_CONFIG_DIR` set is not the account a plain `claude` uses, even for the same folder. Name the accounts agents may run as:

```
AGENT_CLAUDE_ACCOUNTS=work=~/.claude,personal=~/.claude-personal
```

Runs then get `CLAUDE_CONFIG_DIR` of the chosen account. With more than one, the story page shows an account choice (the first is the default); the run records which account it used. Sign each account in with `CLAUDE_CONFIG_DIR=<folder> claude /login`.

## How it works

The **Agents** card on a story page has three actions:

- **Plan** runs `/bmad-build-auto` with "Halt after planning.": it writes the story's spec, sets it to `ready-for-dev` and stops. Start dev later builds from that spec.
- **Start dev** runs `/bmad-build-auto` for the story: it plans (when there is no ready spec yet) and builds.
- **Start review** runs `/bmad-code-review` for the story. With **Review fixes its findings** on, the review applies its fixes; off, it only reports them.

Each action has a model choice, pre-filled from the project's `story-complexity.md` (a table with a `Story` and a `Model` column):

- Plan and dev use the first model the row names (`Opus (core) · Haiku (theme)` → Opus).
- Review uses one tier higher (Haiku → Sonnet, Sonnet → Opus, Opus stays Opus).
- Without a row, plan and dev use Sonnet and review Opus.

A plan and a dev run for the same story never run at the same time; they write the same spec.

The card offers what fits the story's status: Plan and Start dev in Backlog, Start dev from Ready for Dev to In Progress (and when Blocked), and Start review only once the story is in Review or Done.

A run is a detached `claude -p` process in the project folder. Its record, prompt and output are files in `.agent-runs/` (or `AGENT_RUNS_DIR`), so runs survive a restart of MyBMAD. The run page shows the log while it runs, the cost and turns when it ends, and a **Stop** button.

### Story status and merging

A **Start dev** run first sets its story to `in-progress` in the checkout's `sprint-status.yaml` and commits only that file, so the status shows while the build runs. A file you are editing by hand is left alone.

A dev run works in its own git worktree and branch. When it finishes, its commits are rebased onto the checkout's branch and fast-forwarded in, one merge at a time. Sprint-status is then set to `review`, `done` or `blocked` on the story branch.

When that rebase hits a conflict, an agent resolves it in the worktree, with the same account and model as the build. It gets up to three tries to finish the rebase. If the conflicts remain, the rebase is aborted and nothing is merged; the run then shows the reason. The resolver's output is saved as `<run-id>.conflict.log` next to the run's other files. Nothing runs the project's tests after a conflict is resolved.

## Autorunner

The **Start autorunner** button above the stories board and above the agent runs starts a queue. It takes open stories (backlog or ready-for-dev) whose dependencies are done, from `story-dependencies.yaml`, and runs each build in auto mode, then a review if that is on. Pick **One at a time** or **Parallel (max 3)**.

- It stops when a story fails, or when a story is blocked in sprint-status. Stories already running finish.
- When the Claude account hits its token limit, the queue waits until the limit resets (from Claude's message, or 30 minutes when there is none) and runs that step again, up to six times.
- **Stop autorunner** lets the running stories finish and starts no new ones.

The queue runs in a detached process (`scripts/autorunner.ts`), so it keeps going when the browser closes. Its state is in `.agent-runs/autorunners/`. The project needs `_bmad-output/implementation-artifacts/sprint-status.yaml` and `story-dependencies.yaml`.

## Auto mode and parallel runs

The project page has an **Agent-instellingen** button with two options, both off by default. They apply to every run of the project until you change them:

- **Autorunner** starts runs with `--permission-mode auto`: Claude Code decides per action. Off, runs use `bypassPermissions`, as before.
- **Een tegelijk** holds a run back until the project's other running agents have finished. Off, runs start at once, so runs of different stories go in parallel. Each new build still gets its own worktree.

A run waiting for others shows as running. A run started in auto mode shows "· auto mode" in its list entry.

`AGENT_COMMAND_TEMPLATE` takes `{permission_mode}` where the mode goes. A template with a fixed `--permission-mode` ignores the choice.

## Security

Agents run headless. With the default mode, they run with `--permission-mode bypassPermissions`: they can run any command and change any file the MyBMAD server user can. Only the owner of a project can start runs for it. Set `AGENT_COMMAND_TEMPLATE` for a stricter command, for example with `--allowedTools`.
