// THE ONE HELPER THIS KIT USED TO EXPECT THE APPLICATION TO EXPORT.
//
// **The same class as the sign-in kit's `lib/sign-in-support.js`, found by that kit's review
// rather than by anybody looking here.** The payments kit reaches
// out of itself for seven names; six — `config`, `optional`, `db`, `headerOf`, `json`, `pathFrom` —
// are exported by all four templates, and `refuseOnPreview` is exported by `web-app-template` alone.
// So an application seeded from `agent-template`, `service-template` or `pipeline-template` whose
// plan calls Stripe would hit exactly the wall the sign-in kit just stopped hitting. Measured, with
// `web-app-template` as the control: that one name is the whole difference.
//
// **It is a file of this kit's own rather than a shared one, and that is the no-overwrite rule
// deciding it.** `kits/assemble.mjs` and the platform's `ensureKits` both refuse to copy a kit file
// over a file that is already there, and CI assembles `sign-in payments` together — so one
// `lib/kit-support.js` carried by both kits would be refused the moment a plan needed both. Each kit
// carrying its own is what makes "both" work.
//
// The cost is the same one the sign-in kit's header states: in a `web_app` there is now more than one
// definition of `refuseOnPreview`, and the payments code uses this one.

import { isPreviewCopy } from './copy.js'

/**
 * Refuse this request if this is the preview copy, or `null` to carry on.
 *
 * For a route whose caller is a third party's machine: the payment provider posts its events to the
 * live address and nobody previewing their own application posts one to it, so refusing costs a
 * preview nothing and takes a public surface off the internet.
 */
export function refuseOnPreview (jsonFn, { error, code }) {
  return isPreviewCopy() ? jsonFn({ error, code }, 403) : null
}
