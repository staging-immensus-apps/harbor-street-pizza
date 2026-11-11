import { useEffect, useId, useRef, type ReactNode } from 'react'

/**
 * A modal dialog, on the browser's own `<dialog>`: it traps focus, closes on Escape and returns focus to
 * the control that opened it, with nothing added to the bundle. Use this rather than `alert`, `confirm`
 * or `prompt`, which cannot be styled and stop the page.
 *
 * Closing by Escape or a click on the backdrop calls `onClose`; the caller holds `open`.
 * Its margin is important because a parent's `space-y-*` would otherwise win and pull it off centre.
 */
export function Dialog ({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
      className="!m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border bg-card p-0 text-card-foreground shadow-lg backdrop:bg-black/50"
    >
      {open && (
        <div className="space-y-4 p-6">
          <div>
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>
            {description && <p className="mt-1 break-words text-sm text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      )}
    </dialog>
  )
}
