THIRD-PARTY NOTICES
===================

CogSend itself is MIT (see LICENSE). Two different sets of packages
deserve credit for different reasons:

- **Bundled into the Worker.** This code is compiled into the artifact you
  deploy, so their notices must travel with it.
- **Build and test tooling.** Installed from npm to build and test the
  project. It is not distributed with the Worker.

Bundled into the Worker
-----------------------

Apache-2.0             1 package
ISC                    1 package
MIT                    12 packages
MPL-2.0                1 package

- @lucide/svelte 1.45.0 — ISC — https://github.com/lucide-icons/lucide
- @modelcontextprotocol/core 2.0.0 — MIT — https://github.com/modelcontextprotocol/typescript-sdk
- @modelcontextprotocol/server 2.0.0 — MIT — https://github.com/modelcontextprotocol/typescript-sdk
- @sveltejs/kit 2.70.3 — MIT — https://github.com/sveltejs/kit
- clsx 2.1.1 — MIT — https://github.com/lukeed/clsx
- cookie 0.6.0 — MIT — https://github.com/jshttp/cookie
- date-fns 4.4.0 — MIT — https://github.com/date-fns/date-fns
- devalue 5.9.4 — MIT — https://github.com/sveltejs/devalue
- drizzle-orm 0.45.2 — Apache-2.0 — https://github.com/drizzle-team/drizzle-orm
- mediabunny 1.61.3 — MPL-2.0 — https://github.com/Vanilagy/mediabunny
- esm-env 1.2.2 — MIT — https://github.com/benmccann/esm-env
- set-cookie-parser 3.1.2 — MIT — https://github.com/nfriedly/set-cookie-parser
- svelte 5.57.0 — MIT — https://github.com/sveltejs/svelte
- uqr 0.1.3 — MIT — https://github.com/unjs/uqr
- zod 4.6.2 — MIT — https://github.com/colinhacks/zod

Build and test tooling (not distributed)
-----------------------------------------

Apache-2.0             2 packages
MIT                    19 packages
MIT OR Apache-2.0      1 package

- @eslint/js 10.0.1 — MIT — https://github.com/eslint/eslint
- @libsql/client 0.18.0 — MIT — https://github.com/tursodatabase/libsql-client-ts
- @modelcontextprotocol/client 2.0.0 — MIT — https://github.com/modelcontextprotocol/typescript-sdk
- @playwright/test 1.63.0 — Apache-2.0 — https://github.com/microsoft/playwright
- @sveltejs/adapter-cloudflare 7.2.9 — MIT — https://github.com/sveltejs/kit
- @sveltejs/vite-plugin-svelte 7.3.0 — MIT — https://github.com/sveltejs/vite-plugin-svelte
- @tailwindcss/vite 4.3.3 — MIT — https://github.com/tailwindlabs/tailwindcss
- @types/node 26.5.1 — MIT — https://github.com/DefinitelyTyped/DefinitelyTyped
- eslint 10.10.0 — MIT — https://github.com/eslint/eslint
- eslint-config-prettier 10.1.8 — MIT — https://github.com/prettier/eslint-config-prettier
- eslint-plugin-svelte 3.23.0 — MIT — https://github.com/sveltejs/eslint-plugin-svelte
- globals 17.12.0 — MIT — https://github.com/sindresorhus/globals
- prettier 3.9.6 — MIT — https://github.com/prettier/prettier
- prettier-plugin-svelte 4.1.1 — MIT — https://github.com/sveltejs/prettier-plugin-svelte
- prettier-plugin-tailwindcss 0.8.1 — MIT — https://github.com/tailwindlabs/prettier-plugin-tailwindcss
- svelte-check 4.7.6 — MIT — https://github.com/sveltejs/language-tools
- tailwindcss 4.3.3 — MIT — https://github.com/tailwindlabs/tailwindcss
- typescript 6.0.3 — Apache-2.0 — https://github.com/microsoft/TypeScript
- typescript-eslint 8.70.0 — MIT — https://github.com/typescript-eslint/typescript-eslint
- vite 8.3.0 — MIT — https://github.com/vitejs/vite
- vitest 5.0.0 — MIT — https://github.com/vitest-dev/vitest
- wrangler 4.131.2 — MIT OR Apache-2.0 — https://github.com/cloudflare/workers-sdk

Notes
-----

- Every package above is permissively licensed (MIT, Apache-2.0, ISC, or
  MIT OR Apache-2.0) except `mediabunny`, which is MPL-2.0. It reads and
  converts video in the browser (WebCodecs) so the platforms get an H.264/AAC
  MP4 without a server-side ffmpeg; the Worker never runs it, and it ships
  only in the composer's client assets, loaded on first video upload. MPL-2.0
  is file-level copyleft: CogSend uses the files unmodified, and their source
  is the published package and the repository linked above. A change to a
  Mediabunny file itself would have to be published under MPL-2.0. The
  build-only tree does pull in two weak-copyleft
  packages:
  `lightningcss` (MPL-2.0, via Tailwind/Vite) and `sharp`/libvips
  (LGPL-3.0-or-later, via wrangler's local runtime). Neither is part of the
  deployed Worker, so no source-offer obligation attaches to the artifact.
- The canonical license text for each package is the one published with it
  on the npm registry (`node_modules/<package>/LICENSE` in a checkout). No
  `node_modules` directory is part of the repository or the Worker bundle.
- Refresh this list after a dependency change:
  `npx wrangler deploy --dry-run --metafile /tmp/meta.json` lists what the
  Worker bundle actually includes.
