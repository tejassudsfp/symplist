# Contributing to Symplist

Thanks for helping make task management simpler. The repository currently contains specifications and design references; there is no runnable application or release yet.

## Before starting

Read the [notes index](docs/notes/files/00_index.md), [design master](design/mockups/overall.md), and the relevant screen briefs. The supplied workspace sample establishes visual direction; it does not cover every required screen. Check issues and open a focused proposal for changes that alter architecture or scope.

## Making a change

1. Fork the repository and create a descriptive branch.
2. Keep the change focused. Preserve user data, existing decisions, and third-party notices.
3. Update related documentation and index links. Clearly distinguish proposed, implemented, and verified behavior.
4. Run checks appropriate to the change. Documentation-only work should check links, formatting, screen coverage, and consistency. Future code contributions must include relevant tests and exact commands/results.
5. Open a pull request explaining the problem, resulting behavior, validation, and any limitations. Include screenshots for visual changes and cover keyboard/mobile states.

Do not commit credentials, `.env` files, private documents, real invite/share links, or production data. Use fictional fixtures. Do not introduce trackers or new content disclosure paths without updating the explicit privacy contract. Dependencies and assets must have compatible licenses and retain required attribution. Imported reference runtimes are not automatically approved production dependencies.

The project uses the existing MIT license for contributions; no separate contributor agreement is currently required. Maintainer review is required before merging. There are no application build/test commands yet; do not invent passing checks. The repository's documentation check runs in CI.
