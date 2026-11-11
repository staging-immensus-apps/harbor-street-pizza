// THE SCHEDULER'S SEAM (resources/Scheduler.js). Every automation this app has is one entry here;
// there is no second scheduler and no admin endpoint that runs a loop by hand.
//
// `everyMinutes` is a per-worker gate and not a schedule: every worker of every node ticks, so a
// loop that must happen once per period claims its run on a table row first. The retention sweep
// does exactly that (lib/retention.js), keyed by the day, which is why running it twice as often as
// a day costs nothing — the second tick finds the finished claim and returns `skipped`. Twelve
// hours rather than twenty-four so that a cluster restarted every morning still sweeps.

import { RETENTION_LOOP, sweepPersonalDetails } from '../retention.js'

export const LOOPS = [
  {
    name: RETENTION_LOOP,
    everyMinutes: 12 * 60,
    run: ({ now, triggeredBy }) => sweepPersonalDetails({ now, triggeredBy }),
  },
]
