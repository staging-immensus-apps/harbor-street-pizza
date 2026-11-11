import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { Me } from '@/api/sign-in'
import { Button } from '@/components/ui/button'
import { Shell } from '@/components/shell'
import Users from '@/pages/admin/Users'

// One entry per section. A left-hand menu appears once there are two, so an app that adds nothing is not
// left with a menu of one item.
const SECTIONS: { to: string; label: string }[] = [
  { to: '/admin/users', label: 'People' },
]

/**
 * /admin/* — the admin area convention: pages under src/pages/admin/*,
 * gated by role === 'admin' in App.tsx, served by routes/spa.js's /admin/* wildcard, all
 * talking to the one resources/AdminApi.js. The builder adds sections here.
 */
export default function Admin({ me }: { me: Me }) {
  const { pathname } = useLocation()
  const pages = (
    <Routes>
      <Route index element={<Navigate to="/admin/users" replace />} />
      <Route path="users" element={<Users me={me} />} />
      <Route path="*" element={<Navigate to="/admin/users" replace />} />
    </Routes>
  )
  return (
    <Shell>
      {SECTIONS.length < 2 ? pages : (
        <div className="grid gap-8 md:grid-cols-[11rem_1fr]">
          <nav className="flex flex-wrap gap-1 md:flex-col">
            {SECTIONS.map((s) => (
              <Button key={s.to} asChild size="sm" variant={pathname.startsWith(s.to) ? 'secondary' : 'ghost'} className="md:justify-start"><Link to={s.to}>{s.label}</Link></Button>
            ))}
          </nav>
          <div className="min-w-0">{pages}</div>
        </div>
      )}
    </Shell>
  )
}
