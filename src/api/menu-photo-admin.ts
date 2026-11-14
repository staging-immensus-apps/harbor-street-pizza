// The owner's photo upload for one menu item (resources/MenuPhotoAdminApi.js). Admin-only, and a
// thin wrapper on purpose: lib/photos.js on the server is the only place that decides what bytes
// are acceptable, so a refusal comes back as a thrown ApiError with `.code` —
// unsupported_type, content_mismatch, too_large, photo_not_stored — rather than anything
// pre-judged here. The menu editor re-encodes a chosen file to JPEG no wider than 1200px before
// calling uploadMenuPhoto; this module does not do that work.

import { api } from './client'
import type { MenuPhotoWrite, MenuPhotoUploadResponse } from './types'

export function uploadMenuPhoto(menuItemId: string, body: MenuPhotoWrite): Promise<MenuPhotoUploadResponse> {
  return api.post<MenuPhotoUploadResponse>(`MenuPhotoAdminApi/${encodeURIComponent(menuItemId)}`, body)
}

export function removeMenuPhoto(menuItemId: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`MenuPhotoAdminApi/${encodeURIComponent(menuItemId)}`)
}
