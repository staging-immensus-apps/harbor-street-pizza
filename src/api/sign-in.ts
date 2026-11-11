// The shapes the sign-in kit's resources answer with. Types only: pages import values
// from '@/api/client' alone, which page-boot-acceptance stubs — a value exported from here would not be
// stubbed, and a type costs nothing at runtime. Copied into an app with the rest of the sign-in kit;
// the app's own response shapes go in src/api/types.ts.

export type User = { id: string; email: string; name: string | null; role: string; createdAt: string | null }

/** The session, as GET /AuthApi/me answers it. */
export type Me =
  | { authenticated: false }
  | { authenticated: true; user: User }

// `emailSignIn` is false when the app has no mail key, so no sign-in link can be sent.
export type AuthConfig = { appName: string; googleClientId: string | null; openSignup: boolean; magicLinkTtlMinutes: number; emailSignIn: boolean }

// GET /Bootstrap/. `needed` is whether the administrator's seat is still open; `mode` is how
// it is taken — 'owner' when the app names its owner, who takes it by signing in with their own email,
// and 'claim' when it does not, where the first visitor to fill in the setup form takes it.
export type BootstrapState = { needed: boolean; mode: 'owner' | 'claim' }

export type AccountView = { user: User }

export type AdminUser = User & {
  deactivatedAt: string | null
  lastLoginAt: string | null
  signIn: { google: boolean; password: boolean }
}
