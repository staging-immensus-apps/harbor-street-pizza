// The public menu (resources/MenuApi.js). No auth, available items only, grouped by category.

import { api } from './client'
import type { MenuResponse } from './types'

export function getMenu(): Promise<MenuResponse> {
  return api.get<MenuResponse>('MenuApi')
}
