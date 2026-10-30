# Changelog

All notable changes to MyBMAD Dashboard are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.2.0] — 2026-10-30

### Added
- Autorunner
  - Project-wide autorunner that works through the story queue, with a one-at-a-time setting
  - Queue above the stories board, showing each queued story's stages, models and log tail
  - Choose the Claude account per project
  - Pace autorunner starts by the plan quota that Claude reports
  - Keep the computer awake while the autorunner runs
  - Compact panel with Pause all, Stop after current and Stop now
  - List of finished autoruns with start, end, duration, tokens and cost
  - Optionally split large stories into subtasks
  - Retry failed builds first and explain the autorunner's choices
- Agent runs
  - Start dev and review runs per story with Claude Code, and plan stories up to ready-for-dev
  - Choose the skill or BMAD agent and the model per action
  - Offer only the actions that fit a story's status
  - Run cards with start, duration, model and cost, with pause and stop per run
  - Run context sheet with story artifacts and diffs
  - Changed files and readable diffs per run
  - Time-stamped run stream with a status dot per log line, and a full log dialog
  - Session and week limits shown at the top right of the agents page
  - Refuse to start a story whose spec is split into subtasks
- Stories
  - Stories board, table and sidebar with agent views
  - Recommended model per story
  - Subtasks nested under their parent, with a done count
  - Show the stories that wait on each story
- Documentation
  - Documentation tab with open-as-HTML buttons for specs
  - `.html` files render as pages in the library
  - Linked markdown specs open inside the app
- Kanban board view for epics with a side panel
- Support for alphanumeric epic IDs, chunked epic directories and BMAD V1 layouts
- Admin metrics and error logging

### Changed
- Interface translated to English (login, errors, labels, run messages and documentation page)
- Prisma migrations run automatically when the container starts
- User roles are enforced at database level
- Admin panel access is set by `SUPER_ADMIN_EMAIL`
- Dashboard shows split stories as split, without run actions
- Loading states are announced to assistive technology

### Fixed
- Authorization and input hardening
- Block new GitHub OAuth accounts when registration is closed
- Cache revalidation route hardening and ordering

---

## [0.1.0] — 2026-02-18

Initial public release.

### Added
- GitHub OAuth authentication via Better Auth
- Import GitHub repositories structured with the BMAD methodology
- Dashboard overview with global stats across all projects
- Per-project views: epics timeline, stories table, docs browser, sprint status
- Velocity metrics and progress tracking
- Markdown/YAML/JSON document viewer with syntax highlighting
- Admin panel for user and role management
- Docker + Traefik production deployment with automatic TLS
- Health check API endpoint (`/api/health`)
- Cache revalidation webhook (`/api/revalidate`)
- Dark/light theme support
- Graceful error handling for parse errors in BMAD files

---

[Unreleased]: https://github.com/jsprhzn/my-bmad/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jsprhzn/my-bmad/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jsprhzn/my-bmad/releases/tag/v0.1.0
