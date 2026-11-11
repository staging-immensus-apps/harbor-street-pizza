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
 * A WRITE CARRIES ITS ID IN THE BODY, NEVER IN A RECORD PATH, and that is measured rather than
 * stylistic. `PATCH /MenuAdminApi/<id>` and `PUT /MenuAdminApi/<id>` both answered 400 on the live
 * /preview deployment for every body — a changed price, a changed description, an availability
 * toggle. The refusal came from Harper's REST layer BEFORE the resource ran: the page showed the
 * bare statusText "Bad Request", and `errorText()` only falls back to that when the JSON body has no
 * `error` key, which every 400 this app writes does carry. Harper reads a single trailing segment as
 * a record id and refuses to hand a custom Resource a write against one; `PUT /StoreSettingsApi`,
 * which has no record segment, answers 200 all along.
 *
 * So the id travels in the body and the path names an ACTION — the one write shape proven live in
 * this deployment (`POST /AuthApi/request-link`, `POST /CheckoutApi/order`,
 * `POST /AdminApi/users/invite`). These signatures are unchanged, so no page changes with them; the
 * resource still answers PATCH and PUT at `/<id>` for anything that reaches it.
 */
export function updateMenuItem(id: string, body: Partial<MenuItemWrite>): Promise<MenuAdminItemResponse> {
  return api.post<MenuAdminItemResponse>('MenuAdminApi/update', { ...body, id })
}

export function deleteMenuItem(id: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>('MenuAdminApi/delete', { id })
}
