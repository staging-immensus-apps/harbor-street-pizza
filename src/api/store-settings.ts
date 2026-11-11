// The owner's shop settings (resources/StoreSettingsApi.js). Admin-only; also carries the date
// customer details were last cleared, read-only, from the retention sweep's LoopRun rows.

import { api } from './client'
import type { StoreSettingsResponse, StoreSettingsWrite } from './types'

export function getStoreSettings(): Promise<StoreSettingsResponse> {
  return api.get<StoreSettingsResponse>('StoreSettingsApi')
}

export function saveStoreSettings(body: StoreSettingsWrite): Promise<StoreSettingsResponse> {
  return api.put<StoreSettingsResponse>('StoreSettingsApi', body)
}
