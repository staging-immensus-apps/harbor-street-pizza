// The shop-level facts a customer needs before ordering (resources/StoreInfoApi.js). Public,
// read-only, always 200 — never a column beyond publicStoreInfo()'s fixed subset.

import { api } from './client'
import type { StoreInfoResponse } from './types'

export function getStoreInfo(): Promise<StoreInfoResponse> {
  return api.get<StoreInfoResponse>('StoreInfoApi')
}
