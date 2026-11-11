import { useEffect, useState, type FormEvent } from 'react'
import { api } from '@/api/client'
import type { Me, AdminUser } from '@/api/sign-in'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeading } from '@/components/shell'
import { errorText, shortDate } from '@/lib/format'

type Role = 'member' | 'admin'
type Invite = { email: string; name: string; role: Role }

const ROLE_LABEL: Record<string, string> = { admin: 'Administrator', member: 'Member' }
const roleLabel = (role: string) => ROLE_LABEL[role] ?? role

function initials(u: AdminUser): string {
  return (u.name || u.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('')
}

/** /admin/users — the people on this app: find them, invite them, change a role, deactivate an account. */
export default function Users({ me }: { me: Me }) {
  const myId = me.authenticated ? me.user.id : null
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [q, setQ] = useState('')
  const [inviting, setInviting] = useState(false)
  const [invite, setInvite] = useState<Invite>({ email: '', name: '', role: 'member' })
  const [managing, setManaging] = useState<AdminUser | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load(query = q) {
    try {
      const r = await api.get<{ users?: AdminUser[] }>(`AdminApi/users?q=${encodeURIComponent(query)}`)
      setUsers(Array.isArray(r?.users) ? r.users : [])
    } catch (err) {
      setUsers([])
      setError(errorText(err, 'Could not load people'))
    }
  }

  useEffect(() => { load('') }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function act<T>(fn: () => Promise<T>, done: string | ((result: T) => string)) {
    setBusy(true)
    setError(null)
    setNotice(null)
    setManaging(null)
    try {
      const result = await fn()
      setNotice(typeof done === 'function' ? done(result) : done)
      await load()
    } catch (err) {
      setError(errorText(err, 'That did not work'))
    } finally {
      setBusy(false)
    }
  }

  function sendInvite(e: FormEvent) {
    e.preventDefault()
    const email = invite.email
    act(async () => {
      const r = await api.post<{ ok: boolean; existing?: boolean; skipped?: boolean }>('AdminApi/users/invite', invite)
      setInvite({ email: '', name: '', role: 'member' })
      setInviting(false)
      return r
    }, (r) => r?.skipped
      // AdminApi answers `skipped` when the app has no mail key: the account exists and no email
      // left. Saying "sent" there is the same false sentence the sign-in page used to show.
      // PLACEHOLDER wording.
      ? `${email} was added, but no invite email was sent: this app cannot send email yet.`
      : `Invite sent to ${email}.`)
  }

  const count = users ? `${users.length} ${users.length === 1 ? 'person' : 'people'}` : 'Loading…'

  return (
    <>
      <PageHeading title="People" description={count} actions={<Button onClick={() => setInviting((v) => !v)}>Invite someone</Button>} />
      <div className="space-y-6">
        {error && <Alert variant="destructive">{error}</Alert>}
        {notice && <Alert>{notice}</Alert>}
        {inviting && (
          <form onSubmit={sendInvite} className="grid gap-2 rounded-xl border bg-card p-4 sm:grid-cols-[2fr_2fr_1fr_auto]">
            <Input type="email" required aria-label="Email" placeholder="Email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            <Input aria-label="Name" placeholder="Name (optional)" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
            <Select aria-label="Role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as Role })}>
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </Select>
            <Button type="submit" disabled={busy}>Send invite</Button>
          </form>
        )}
        <div className="overflow-hidden rounded-xl border bg-card">
          <form onSubmit={(e) => { e.preventDefault(); load() }} className="border-b p-3">
            <Input aria-label="Search" className="max-w-xs border-transparent bg-muted shadow-none" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                <TableHead className="hidden md:table-cell">Last signed in</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users === null ? (
                <TableRow><TableCell colSpan={5} className="p-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>
              ) : users.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="p-8 text-center text-muted-foreground">Nobody matches that search.</TableCell></TableRow>
              ) : users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-3">
                      <span aria-hidden="true" className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground sm:flex">{initials(u)}</span>
                      <div className="min-w-0 max-w-[7rem] sm:max-w-none">
                        <div className="truncate font-medium">{u.name ?? u.email}{u.id === myId ? <span className="font-normal text-muted-foreground"> · you</span> : null}</div>
                        {u.name && <div className="truncate text-muted-foreground">{u.email}</div>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>{roleLabel(u.role)}</Badge></TableCell>
                  <TableCell className="hidden sm:table-cell"><Badge variant={u.deactivatedAt ? 'outline' : 'secondary'}>{u.deactivatedAt ? 'Deactivated' : 'Active'}</Badge></TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{u.lastLoginAt ? shortDate(u.lastLoginAt) : 'Never'}</TableCell>
                  <TableCell className="pr-3 text-right">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setManaging(u)}>Manage</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
      <ManageDialog
        user={managing}
        isSelf={managing?.id === myId}
        onClose={() => setManaging(null)}
        onRole={(u, role) => act(() => api.put(`AdminApi/users/${u.id}/role`, { role }), `${u.email} is now ${roleLabel(role).toLowerCase()}.`)}
        onActive={(u, deactivated) => act(() => api.put(`AdminApi/users/${u.id}/deactivated`, { deactivated }), `${u.email} ${deactivated ? 'deactivated' : 'reactivated'}.`)}
      />
    </>
  )
}

/** One person's role and whether their account is active. The server refuses a change that would leave no administrator. */
function ManageDialog({ user, isSelf, onClose, onRole, onActive }: { user: AdminUser | null; isSelf: boolean; onClose: () => void; onRole: (u: AdminUser, role: string) => void; onActive: (u: AdminUser, deactivated: boolean) => void }) {
  const [role, setRole] = useState('member')
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (user) setRole(user.role)
    setConfirming(false)
  }, [user])
  return (
    <Dialog open={user !== null} onClose={onClose} title={user?.name || user?.email || ''} description={user?.name ? user.email : undefined}>
      {user && (
        <>
          <div className="space-y-2">
            <Label htmlFor="manage-role">Role</Label>
            <Select id="manage-role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </Select>
            {isSelf && user.role === 'admin' && role !== 'admin' && <p className="text-sm text-muted-foreground">You will lose access to this page.</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button disabled={role === user.role} onClick={() => onRole(user, role)}>Save</Button>
          </div>
          <div className="space-y-3 border-t pt-4">
            {user.deactivatedAt ? (
              <Button variant="outline" className="w-full" onClick={() => onActive(user, false)}>Reactivate account</Button>
            ) : confirming ? (
              <>
                <Alert variant="destructive">{isSelf ? 'You will be signed out and will not be able to sign in.' : 'They will be signed out and will not be able to sign in.'}</Alert>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setConfirming(false)}>Keep account</Button>
                  <Button variant="destructive" onClick={() => onActive(user, true)}>Deactivate</Button>
                </div>
              </>
            ) : (
              <Button variant="outline" className="w-full" onClick={() => setConfirming(true)}>Deactivate account</Button>
            )}
          </div>
        </>
      )}
    </Dialog>
  )
}
