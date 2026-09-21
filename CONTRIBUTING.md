# Contributing to Symplist

Thanks for helping make task management simpler. The repository currently contains specifications and design references; there is no runnable application or release yet.

## Before starting

Read the [notes index](docs/notes/files/00_index.md). Check issues and open a focused proposal for changes that alter architecture or scope.

## Making a change

1. Fork the repository and create a descriptive branch.
2. Keep the change focused. Preserve user data, existing decisions, and third-party notices.
3. Update related documentation and index links. Clearly distinguish proposed, implemented, and verified behavior.
4. Run checks appropriate to the change. Documentation-only work should check links, formatting, screen coverage, and consistency. Future code contributions must include relevant tests and exact commands/results.
5. Open a pull request explaining the problem, resulting behavior, validation, and any limitations. Include screenshots for visual changes and cover keyboard/mobile states.

Do not commit credentials, `.env` files, private documents, real invite/share links, or production data. Use fictional fixtures. Do not introduce trackers or new content disclosure paths without updating the explicit privacy contract. Dependencies and assets must have compatible licenses and retain required attribution. Imported reference runtimes are not automatically approved production dependencies.

The project uses the existing MIT license for contributions; no separate contributor agreement is currently required. Maintainer review is required before merging. There are no application build/test commands yet; do not invent passing checks. The repository's documentation check runs in CI.

## Main branch policy

All changes to `main` must go through a pull request. Only repository owner
`tejassudsfp` can merge. Active GitHub rulesets restrict updates to that user
in pull-request context and separately require passing documentation CI,
an up-to-date branch, and resolved review conversations, with no bypass of
those requirements. Direct pushes, force pushes, and deletion are blocked.
An additional approval is not required so the owner can merge their own PRs;
CODEOWNERS still identifies the maintainer for review requests.

Use a feature branch or fork, wait for checks, and leave merging to the owner.
Repository rules are configured on GitHub; this document alone does not enforce
them. The owner retains administrative ability to change repository settings.
