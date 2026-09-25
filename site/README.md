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

## Netlify

The site is live at https://ultimate-workspace.netlify.app. The root `netlify.toml` tells Netlify to run `npm run site:build` and publish `dist-site/`, so the same command works for CI deploys if the GitHub repo is connected in the Netlify UI.

Manual redeploy after a change (the folder is already linked via `.netlify/state.json`):

```sh
npm run site:build
netlify deploy --prod
```

## Tests

```sh
npm test -- site/landing.test.mjs
```

The landing tests use Vitest and are also included in the full `npm test` suite.

## Content and interactions

- The workspace visual is a real screenshot of the desktop app (`public/app-desktop.webp`, captured on Windows and converted from PNG to WebP). It is a static image, not a live session. Replace it when the UI changes and keep the `width`/`height` attributes in `index.html` in sync.
- The mobile visual is the real Relay Mobile app (`public/app-mobile.webp`): `npx expo export --platform web` in `mobile/`, then screenshot the export at a 393×852 phone viewport (3× scale, dark theme) and present it inside the CSS device frame. It shows the app's pairing screen, because a browser render has no paired desktop.
- The three story visuals (parallel panes, Session Mesh + memory, Vault) are CSS diagrams, not screenshots, and are labelled as diagrams for assistive tech.
- Page structure follows the product: hero → workspace shot → agent CLIs → the workbench (parallel panes, Session Mesh + memory, Vault + knowledge search) → generation (documents, diagrams, images, voice) → a workbench grid (terminal, browser, git, automations, cost, connectors, MCP, hooks, permissions, skills, palette, themes) → model ownership → FAQ → mobile companion → download.
- FAQ disclosures use native HTML details/summary.
- Download links go to the public releases-only repo (`Sabbir505/relay-releases`) latest-release page, not a hardcoded installer version. The source repo is private; downloads and the app's auto-update feed live there.
- The site advertises Windows distribution and distinguishes local workspace storage from cloud-provider requests.
- The logo is copied from the existing product asset in `public/logo.png`.
- Typography and palette are aligned with the desktop app: Space Grotesk (display), Inter (body), Space Mono (labels), on the app’s cyan accent (`#88c0d0`) and dark surface.
- Progressive enhancement: the sticky-header glass state, nav scroll-spy, and reveal-on-scroll only run with JavaScript. With JS off the page renders complete, and `prefers-reduced-motion` disables the motion. There is no analytics or form submission.
