# Contributing

TeleCoder is maintained by [@gitaarik](https://github.com/gitaarik). Issues and pull
requests are welcome. See [ROADMAP.md](ROADMAP.md) for what's planned.

## Setup

```bash
git clone https://github.com/gitaarik/telecoder.git
cd telecoder
npm install
npm run typecheck
npm test
```

The tests need no Telegram bot, no Claude login and no `.env`: `vitest.config.ts` supplies
dummy values and keeps the suite away from any real `.env`. To run the bot itself, follow
the [Quick Start](README.md#quick-start).

## Before you open a pull request

- `npm run typecheck`, `npm test` and `npm run build` pass (CI runs the same three)
- New behaviour has tests
- Commands and user-facing features are reflected in `README.md` and `docs/index.html`
- User-visible changes have an entry under "Unreleased" in `CHANGELOG.md`

## Code

- TypeScript, with functional patterns preferred
- Reuse the helpers in `src/utils/`, especially for anything that handles outside input:
  `isValidProtocol()` for URLs, `sanitizePath()` for paths, `sanitizeError()` before
  logging, `isValidImageFile()` for images
- Never put tokens or secrets in process arguments, in the repository or in test fixtures

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`docs:`, `test:`). Say in the body why the change is needed, since the changelog links to
those bodies for the full reasoning.
