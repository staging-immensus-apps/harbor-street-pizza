// The owner's menu editor (resources/MenuAdminApi.js). Admin-only; every item including hidden ones.

import { api } from './client'
import type { MenuAdminListResponse, MenuAdminItemResponse, MenuItemWrite } from './types'

export function listMenuItemsAdmin(): Promise<MenuAdminListResponse> {
  return api.get<MenuAdminListResponse>('MenuAdminApi')
}

export function createMenuItem(body: MenuItemWrite): Promise<MenuAdminItemResponse> {
  return api.post<MenuAdminItemResponse>('MenuAdminApi', body)
}

export function updateMenuItem(id: string, body: Partial<MenuItemWrite>): Promise<MenuAdminItemResponse> {
  return api.patch<MenuAdminItemResponse>(`MenuAdminApi/${encodeURIComponent(id)}`, body)
}

export function deleteMenuItem(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`MenuAdminApi/${encodeURIComponent(id)}`)
}
