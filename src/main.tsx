import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { BASE } from './api/client'
import './index.css'

// `basename={BASE}` is what makes the app ROUTE under /preview, and without it the preview serves
// a shell that renders nothing. `routes/spa.js`
// answers `index.html` at /preview and at every /preview page route, and `api/client.ts` prefixes
// every request and both 403 redirects — but react-router matches on the raw pathname, so at
// /preview/account it would look for a route called `/preview/account`, find none, and fall through
// to the catch-all. Every `<Link to="/x">` and `navigate('/x')` would also walk the person out of
// their preview and into the live app with nothing on screen saying so.
//
// ONE CONSTANT CARRIES ALL THREE — the API base, the redirects and now the router — because `BASE`
// is the mount of the copy that served this bundle: `''` at the root, `/preview`, or a sharing app's
// `/<slug>` and `/<slug>/preview`. `page-boot-acceptance` stubs the client and
// mounts at `/`, so it cannot see this; `preview-acceptance` drives the rule instead.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={BASE}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
