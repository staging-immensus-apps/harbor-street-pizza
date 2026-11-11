// The sign-in kit's settings: the session, the owner's address, sign-up, Google and mail.
//
// THE PROBLEM. The template core is bare bones, so its `lib/config.js` reads nothing about
// accounts. This kit is copied
// into an app only when the plan says people sign in, and its settings have to come from the same place
// every other setting does — this copy's own `CONFIG.env`, never `process.env` while that file exists
// (lib/config.js's header).
//
// → so this module adds the kit's getters to the core's `config` and reads them with the core's own
// readers. The kit EXTENDS the core and the core knows nothing about the kit: nothing in the core
// imports this file, and a kit that edited `lib/config.js` instead would be a kit the platform refuses
// to copy (it never overwrites a file the app already has).
//
// → THE MAIL PAIR AND THE OWNER'S ADDRESS ARE READ THROUGH `secretSource`, and their names come from the
// core's `PER_APP_VALUES` list. The list stays in the core because it is the whole set of names allowed
// to cross between the published copy and the preview copy through `process.env`; lib/config.js's
// header says why each is safe to share.
//
// Every kit file imports `config` from HERE rather than from lib/config.js, so one name carries both the
// core getters and these.

import { config as core, required, optional, flag } from './config.js'
import { MAIL_PAIR, OWNER_KEY, isBlank, nonNegNumber, secretSource } from './sign-in-support.js'

// THE MAIL KEY AND ITS SENDER ARE READ FROM ONE PLACE, CHOSEN BY THE KEY. The control plane mints a
// Resend key scoped to one sending domain and delivers the address on that domain beside it, so a key
// from one source with a sender from the other is a pair Resend refuses.
const fromMailPair = (name, fallback) => {
  const v = secretSource(MAIL_PAIR[0])[name]
  return isBlank(v) ? fallback : v
}

export const config = {
  ...core,

  session: {
    secret: () => required('SESSION_SECRET'),
    ttlHours: () => nonNegNumber('SESSION_TTL_HOURS', 720),
  },

  // THE APP OWNER'S ADDRESS, as delivered, or `null` when none is (lib/config.js's header names
  // it as the fifth per-app value). When it is set, the first sign-in from that address while the app has
  // no active administrator makes that account the administrator, and `POST /Bootstrap/` is refused
  // (lib/auth.js `ownerSetting`). ABSENT OR BLANK IS THE OLDER BEHAVIOUR — first come, through
  // `POST /Bootstrap/` — because "nobody may become admin" would lock every app without the setting out.
  // Returned raw and trimmed rather than normalized: the normalizing, and the decision about a value that
  // is not an address, are lib/auth.js's.
  ownerEmail: () => {
    const v = secretSource(OWNER_KEY)[OWNER_KEY]
    return isBlank(v) ? null : String(v).trim()
  },

  auth: {
    // May an unknown email create an account by requesting a magic link or signing in with Google?
    // The platform writes this from the plan, which has to say. MISSING MEANS NO, so nothing that fails
    // to write it can open a private app: only Bootstrap / an admin create rows then — and, while the
    // app has no administrator, the account of the owner `OWNER_EMAIL` names (lib/auth.js). An app run
    // anywhere else that wants self-serve sign-up sets `AUTH_OPEN_SIGNUP=true`.
    openSignup: () => flag('AUTH_OPEN_SIGNUP', false),
    magicLinkRateLimit: () => nonNegNumber('MAGIC_LINK_RATE_LIMIT', 3),
    magicLinkRateWindowMinutes: () => nonNegNumber('MAGIC_LINK_RATE_WINDOW_MINUTES', 60),
  },

  google: {
    // Blank disables Google sign-in: AuthApi/google answers 503 rather than verifying
    // against an empty audience.
    clientId: () => optional('GOOGLE_CLIENT_ID', ''),
  },

  email: {
    // THE USER'S OWN, minted by the control plane on their Resend account for this app's own sending
    // domain and delivered with the address on that domain. Read as a pair, from
    // this copy's own file when it carries a key and from the cluster's secret store otherwise.
    // Blank means mail is not set up: `AuthApi/request-link` then says so instead of issuing a link
    // nobody can receive, and any other sender logs the message.
    resendApiKey: () => fromMailPair('RESEND_API_KEY', ''),
    from: () => fromMailPair('EMAIL_FROM', 'no-reply@mail.immensus.app'),
    configured: () => !isBlank(fromMailPair('RESEND_API_KEY', '')),
    // Resend signs delivery and inbound webhooks with svix. Blank REFUSES every webhook
    // rather than accepting unsigned ones — see resources/InboundEmailApi.js.
    webhookSecret: () => optional('RESEND_WEBHOOK_SECRET', ''),
  },
}
