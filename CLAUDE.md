# TeleCoder Development Guidelines

## Website and docs (MANDATORY)

**Every change to functionality updates the docs in the same commit.** The docs are the
Markdown pages in `site/src/content/docs/`, built with Astro + Starlight into the next
telecoder.dev (`cd site && npm run dev` to preview):

- **Commands**: a row in `reference/commands.md`. `npm run build` in `site/` (and the Site
  workflow) fails when a command registered in `src/bot/bot.ts` is missing from that page,
  or the page lists one the bot doesn't register.
- **Features**: `guides/features.md`, plus the guide the feature belongs to.
- **Settings**: `reference/configuration.md`.
- **Links** between pages are relative `.md` paths (`../guides/sharing.md#group-roles`), so
  they work on GitHub too; `site/src/plugins/remark-md-links.mjs` turns them into routes.
  Link files outside `site/` by their full GitHub URL.

### Until the domain switch: `docs/index.html`

telecoder.dev still serves the single page `docs/index.html` until the new site replaces it,
so keep its feature cards, command rows and contributors current too, as below.

### New Features
Add a feature card to the features grid. Use the `data-category` attribute for tab filtering (valid values: `agent`, `reliability`, `sessions`, `background`, `media` — these must match the `data-category` on the filter tabs):
```html
<div class="feature-card" data-category="agent">
  <div class="feature-icon"><svg><use href="#i-name"/></svg></div>
  <h3>Feature Name</h3>
  <p>Brief description of what the feature does.</p>
</div>
```

Icons are inline `<symbol>` definitions near the top of `docs/index.html`, not emoji — the
page ships no external assets. Reuse an existing `#i-*` id, or add a new `<symbol>` in the
same 24x24 stroke style if none fits.

### New Commands
Add a command row to the appropriate category section in the commands grid:
```html
<div class="command-row">
  <code class="command-code">/command &lt;args&gt;</code>
  <span class="command-desc">Description of what the command does</span>
</div>
```

### New Contributors
When a new contributor makes significant contributions (check `git shortlog -sn`), add them to the contributors section:
```html
<a href="https://github.com/username" class="contributor-card" target="_blank">
  <img src="https://github.com/username.png" alt="username" class="contributor-avatar">
  <span class="contributor-name">Display Name</span>
  <span class="contributor-role">Contributor</span>
</a>
```

### Pre-commit Check
Before committing, verify that the docs in `site/` are current, and that `docs/index.html` reflects ALL:
- Feature cards for every user-facing feature
- Command rows for every bot command registered in `src/bot/bot.ts` and `src/bot/command-catalog.ts`
- Contributor cards for every contributor with 3+ commits **whose GitHub account still
  exists** — a deleted account gives a 404 avatar and a dead link, so leave it off the
  page. The credit stays in the git history either way. Verify with
  `curl -o /dev/null -w '%{http_code}' https://github.com/<user>.png` (302 = fine,
  404 = gone).

## Code Style

- TypeScript for all source files
- Functional patterns preferred
- Use existing utilities from `src/utils/` (download, sanitize, file-type)
- Validate external input (URLs, file content) using existing helpers

## Security Checklist

Before committing changes that handle external input:
- [ ] URL validation using `isValidDownloadUrl()` from `src/utils/download.ts` (downloads go through `downloadFileSecure()`)
- [ ] Path sanitization using `sanitizePath()` from `src/utils/sanitize.ts`
- [ ] Error sanitization using `sanitizeError()` before logging (it also redacts bot tokens and API keys; `redactSecrets()` for non-error strings)
- [ ] File content validation using `isValidImageFile()` for images
- [ ] No tokens or secrets in process arguments (download with `downloadFileSecure()`, which uses in-process fetch, not curl)

## Git Workflow

Commit directly to `main`. There's no need for feature branches while one person is working on this project, which is the case for the moment — revisit this if someone else joins.
