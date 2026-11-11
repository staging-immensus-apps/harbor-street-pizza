// The payments kit's settings: the user's own Stripe secret key and webhook signing secret.
//
// THE PROBLEM. The template core is bare bones, so its `lib/config.js` reads
// nothing about payments. This kit is copied into an app only when the plan calls api.stripe.com, and
// its settings come from the same place every other setting does — this copy's own `CONFIG.env` — so
// this module adds the kit's getters to the core's `config` with the core's own reader. Nothing in the
// core imports this file.
//
// THE USER'S OWN STRIPE CREDENTIALS. A generated app takes payments through the user's own Stripe
// account, with the user's own key, and Immensus is not in the payment path: a proxy would make our
// server a required part of taking a payment, so the app could not keep charging on another Harper
// instance or on the thirty-first day after a customer leaves.
//
// Both are the USER's, sealed on the control plane's `app_env` custody row and written into CONFIG.env at
// deploy time like every other key. Neither is ever minted here and neither can be
// read back out of Stripe, so a lost key is re-pasted by the user rather than recovered.
//
// Blank is ABSENT and that is the whole of the configured/unconfigured distinction: an app whose user has
// not connected Stripe refuses a payment with a named code rather than calling Stripe anonymously
// (lib/stripe.js `stripeConfigured`).
//
// TEST AND LIVE ARE THE USER'S TOO, because Stripe issues those keys separately: "go live" is the user
// swapping which key the app holds, not a flag the platform sets, and so there is deliberately no mode
// variable here to disagree with the key.

import { config as core, optional } from './config.js'

export const config = {
  ...core,
  stripe: {
    secretKey: () => optional('STRIPE_SECRET_KEY', ''),
    // Stripe signs every webhook with this; blank REFUSES every event rather than accepting
    // unsigned ones — see resources/StripeWebhook.js.
    webhookSecret: () => optional('STRIPE_WEBHOOK_SECRET', ''),
  },
}
