// The shapes the app's own resources answer with. Types only: pages import values
// from '@/api/client' alone, which page-boot-acceptance stubs — a value exported from here would not
// be stubbed, and a type costs nothing at runtime.
//
// The template core has no resources that answer anything but the build stamp, so this file starts
// empty. A kit the platform copies in brings its own types beside it (the sign-in kit's are
// src/api/sign-in.ts).

export {}
