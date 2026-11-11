// The owner's menu editor (resources/MenuAdminApi.js). Admin-only; every item including hidden ones.

import { api } from './client'
import type { MenuAdminListResponse, MenuAdminItemResponse, MenuItemWrite } from './types'

export function listMenuItemsAdmin(): Promise<MenuAdminListResponse> {
  return api.get<MenuAdminListResponse>('MenuAdminApi')
}

export function createMenuItem(body: MenuItemWrite): Promise<MenuAdminItemResponse> {
  return api.post<MenuAdminItemResponse>('MenuAdminApi', body)
}

/**
 * The id travels in the body and the path names an action. UNRESOLVED, and NOT a measured rule:
 * this shape was adopted on the theory that Harper refuses a write whose path names a record, and
 * QA on this build falsified it — `POST /MenuAdminApi/update` and `POST /MenuAdminApi/delete` carry
 * no record segment and still answer 400, including on a save that changed no values. An earlier
 * round had already discarded "the verb is the variable" (PATCH→PUT changed nothing). The cause is
 * NOT KNOWN; CLAUDE.md §7 "OPEN QUESTION" records the evidence still missing. Do not reshape these
 * calls again before one raw failing response and its server log line have been captured.
 */
export function updateMenuItem(id: string, body: Partial<MenuItemWrite>): Promise<MenuAdminItemResponse> {
  return api.post<MenuAdminItemResponse>('MenuAdminApi/update', { ...body, id })
}

export function deleteMenuItem(id: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>('MenuAdminApi/delete', { id })
}
