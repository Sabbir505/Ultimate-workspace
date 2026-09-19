# Relay landing page

Standalone marketing site, separate from the Tauri desktop entry. Uses semantic HTML, scoped standalone CSS, and a small JavaScript module; no additional dependencies.

## Run

From the repository root:

```sh
npm run site:dev
```

Open http://127.0.0.1:1510.

## Build and preview

```sh
npm run site:build
npm run site:preview
```

Preview: http://127.0.0.1:1511. Deploy the contents of `dist-site/` to a static host. Relative asset URLs support subdirectory hosting. The existing `npm run build` and Tauri output remain unchanged.

## Tests

```sh
npm test -- site/landing.test.mjs
```

The landing tests use Vitest and are also included in the full `npm test` suite.

## Content and interactions

- The workspace is an illustrative demo with synthetic content, not a live agent session or screenshot.
- Workspace tabs support click, arrow keys, Home, and End.
- FAQ disclosures use native HTML details/summary.
- Download links go to the repository’s latest GitHub release page, not a hardcoded installer version.
- The site advertises Windows distribution and distinguishes local workspace storage from cloud-provider requests.
- The logo is copied from the existing product asset in `public/logo.png`.
- Typography uses Google Fonts with system fallbacks. There is no analytics or form submission.
