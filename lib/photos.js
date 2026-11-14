// A MENU ITEM'S PHOTO — the one place the bytes of an upload are judged, stored and read back.
//
// Shared by four resources, which is why it is a module and not a method: `MenuPhotoAdminApi` writes
// one, `MenuPhotoApi` serves it, `MenuAdminApi` deletes it with its item, and `lib/menu.js` composes
// the URL the public menu renders. A second opinion about what an acceptable image is — in any one of
// them — is how an item ends up with bytes no screen can draw.
//
// THE BYTES ARE NEVER TRUSTED BECAUSE THE CONTENT TYPE SAYS SO. A caller sends `contentType` and
// base64, and both can be anything; `decodePhoto()` requires the declared type to be one of the two
// the shop supports AND the first bytes to be that format's own signature, so `image/png` carrying a
// zip is refused here rather than served to a customer as an image.
//
// VERIFY ON WRITE (rule 8). `new Blob([buf], { type })` is the only way a Blob is made here, and
// `verifyStoredPhoto()` reads the stored row back and compares the byte length against what was
// written. The caller deletes the row when they disagree — a half-written photo must not sit in the
// table looking like a photo.
//
// Imports no database and no `harperdb`: drivable by a probe on its own.

import { previewPath } from './copy.js'

/** The two formats a phone camera and a laptop both produce, and nothing else. */
export const PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png']

/**
 * 5 MB of DECODED bytes. The menu editor re-encodes a chosen file to JPEG no wider than 1200px
 * before it ever reaches here, so this is the guard on what is left rather than the working limit.
 */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024

// base64 is 4 characters per 3 bytes; a little slack for whitespace and padding. Checked BEFORE the
// decode so a caller cannot make this process allocate a gigabyte to be told it was too large.
const BASE64_MAX_CHARS = Math.ceil(PHOTO_MAX_BYTES / 3) * 4 + 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]

/**
 * Where the public menu points at an item's photo, or null when it has none.
 *
 * `?v=` is `photoUpdatedAt`, so replacing a photo changes the URL and no customer is served the old
 * one out of a cache. Site-relative and through `previewPath()` (rule 30): the preview copy's menu
 * must ask the preview copy for its bytes, or it would draw the published shop's photos.
 */
export function photoUrlFor (menuItemId, photoUpdatedAt) {
  if (!menuItemId || !photoUpdatedAt) return null
  return `${previewPath(`/MenuPhotoApi/${encodeURIComponent(menuItemId)}`)}?v=${encodeURIComponent(photoUpdatedAt)}`
}

/**
 * Turn `{ dataBase64, contentType }` from a request into bytes, or refuse.
 *
 * `{ error, code }` or `{ value: { buffer, contentType, byteSize } }`. Every refusal names what is
 * wrong, because the owner is the only caller and a photo that will not upload with no reason given
 * is a support question.
 */
export function decodePhoto ({ dataBase64, contentType } = {}) {
  const declared = String(contentType ?? '').split(';')[0].trim().toLowerCase()
  if (!PHOTO_CONTENT_TYPES.includes(declared)) {
    return { error: `a photo must be ${PHOTO_CONTENT_TYPES.join(' or ')}`, code: 'unsupported_type' }
  }
  const raw = typeof dataBase64 === 'string' ? dataBase64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '') : ''
  if (!raw) return { error: 'no image data', code: 'no_image' }
  if (raw.length > BASE64_MAX_CHARS) return { error: 'that photo is larger than 5 MB', code: 'too_large' }

  let buffer
  try {
    buffer = Buffer.from(raw, 'base64')
  } catch {
    return { error: 'the image data is not base64', code: 'bad_encoding' }
  }
  if (!buffer.length) return { error: 'the image data is not base64', code: 'bad_encoding' }
  if (buffer.length > PHOTO_MAX_BYTES) return { error: 'that photo is larger than 5 MB', code: 'too_large' }
  if (!signatureMatches(buffer, declared)) {
    return { error: `that file is not a ${declared === 'image/png' ? 'PNG' : 'JPEG'} image`, code: 'content_mismatch' }
  }
  return { value: { buffer, contentType: declared, byteSize: buffer.length } }
}

/**
 * Is this stored row one `MenuPhotoApi` could serve, judged from its METADATA alone?
 *
 * The public menu asks this before it publishes a `photoUrl`, because the two facts "this item has a
 * photo" and "there are bytes behind it" were kept by two different writers and drifted apart: the
 * menu advertised a URL for every item carrying `photoUpdatedAt`, and every one of those URLs
 * answered 404 because no `MenuItemPhoto` row had been written at all. A customer saw a broken
 * image, which is worse than an item with no photo.
 *
 * Metadata only — no `data` column is touched — so a menu of N photographed items costs N keyed
 * reads and no bytes. It is deliberately WEAKER than what `MenuPhotoApi` checks before it serves
 * (that route also reads the bytes back and matches their signature): this one is a cheap "is there
 * a photo here at all", and the route stays the only judge of whether the bytes are real.
 */
export function photoIsServable (row) {
  if (!row) return false
  if (!PHOTO_CONTENT_TYPES.includes(row.contentType)) return false
  return Number.isFinite(row.byteSize) ? row.byteSize > 0 : Boolean(row.data)
}

/** Does the start of `buffer` carry the signature `contentType` claims? */
export function signatureMatches (buffer, contentType) {
  const want = contentType === 'image/png' ? PNG_SIGNATURE : JPEG_SIGNATURE
  if (!buffer || buffer.length < want.length) return false
  return want.every((byte, i) => buffer[i] === byte)
}

/**
 * The `MenuItemPhoto` row for an item. The id IS the `MenuItem` id, so an item has at most one photo
 * and replacing it is a put on the same key.
 *
 * `uploadedAt` is the app's own plain String column — `MenuItemPhoto` declares no `@createdTime` or
 * `@updatedTime`, so this record names nothing Harper owns (CLAUDE.md §8) and needs no
 * `withoutManaged()`. The MenuItem write that follows it does.
 */
export function photoRecord (menuItemId, { buffer, contentType }, now = new Date()) {
  return {
    id: String(menuItemId),
    contentType,
    byteSize: buffer.length,
    data: new Blob([buffer], { type: contentType }),
    uploadedAt: now.toISOString(),
  }
}

/**
 * The bytes of a stored row's `data`, whatever shape the runtime hands them back in — a Blob under
 * Harper, and whatever a probe put there. `null` when there are none.
 */
export async function photoBytes (row) {
  const data = row?.data
  if (!data) return null
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (typeof data === 'string') return Buffer.from(data, 'base64')
  if (typeof data.arrayBuffer === 'function') return Buffer.from(await data.arrayBuffer())
  // The shapes below are not what `new Blob([buf], { type })` reads back as today; they are what a
  // store MAY hand back for the same column, and a photo that cannot be read is served as a broken
  // image — the exact failure this file exists to prevent. Reading one more shape costs nothing;
  // guessing wrong costs every customer the picture.
  if (typeof data.stream === 'function') return collect(data.stream())
  if (typeof data[Symbol.asyncIterator] === 'function') return collect(data)
  // The JSON form of a Buffer, `{ type: 'Buffer', data: [...] }`, which is what a round trip through
  // a serializer leaves behind.
  if (Array.isArray(data.data)) return Buffer.from(data.data)
  return null
}

/** Drain an async iterable of chunks into one Buffer, or null when it yields nothing usable. */
async function collect (source) {
  const chunks = []
  try {
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  } catch {
    return null
  }
  return chunks.length ? Buffer.concat(chunks) : null
}

/**
 * Rule 8's verify-on-write, as a verdict: read the stored row back and say whether its bytes are the
 * ones that were written. The caller deletes the row when this is false — a `MenuItem` whose
 * `photoUpdatedAt` points at a truncated blob serves a broken image to every customer, which is
 * worse than an item with no photo.
 */
export async function verifyStoredPhoto (stored, expected) {
  if (!stored) return false
  if (stored.byteSize !== expected.byteSize) return false
  const bytes = await photoBytes(stored)
  if (!bytes || bytes.length !== expected.byteSize) return false
  return signatureMatches(bytes, stored.contentType)
}
