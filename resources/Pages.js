// SEEDED — the one line that puts this copy's pages and build stamp on the internet.
//
// lib/pages.js holds the rule and imports no Harper, so it can be driven by a suite; this module is
// where Harper hands a component its `server` global, which is only in the modules `jsResource` loads.
// It EXPORTS NO RESOURCE, deliberately: `jsResource` registers a module's Resource exports and loads a
// module with none for its side effect, so a class here would be a second public endpoint nobody asked
// for.
//
// `before: 'rest'` puts the listener in the main chain ahead of REST, which is where a page route has to
// be answered (REST would otherwise answer 404 for a path that names no resource). It passes no
// `urlPath`: a listener given one gets an EXCLUSIVE sub-chain containing only itself, whose next layer
// falls off the end (measured 2026-10-14 on harper@5.3.1), and the prefix test is lib/pages.js's own.
//
// EVERY COPY NAMES ITS LISTENER FROM ITS OWN MOUNT — `immensus-pages` at the root, then
// `immensus-pages/preview`, `immensus-pages/tracker`, `immensus-pages/tracker/preview` — because every
// copy on the cluster shares one chain, and a chain resolves a name to the first listener that took it
// (harper@5.3.3 `server/middlewareChain.ts`, read 2026-10-29). The mount is the one value no two copies
// share, and `/` cannot occur inside a mount's segment, so no two mounts make one name.
// Every copy with a path used to be `immensus-pages-preview`, a name a sharing app and its
// own preview copy would both have taken.

import { createPagesListener } from '../lib/pages.js'
import { copyBase, sharingMounts } from '../lib/copy.js'

const base = copyBase()
server.http(createPagesListener({ base, declined: sharingMounts() }), { before: 'rest', name: `immensus-pages${base}` })
