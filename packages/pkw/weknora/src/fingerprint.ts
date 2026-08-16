/**
 * Remote payload fingerprint + canonicalization for the WeKnora integration.
 *
 * This is the SINGLE place where "what bytes did we send / what bytes came
 * back" is turned into a comparable identity. Both the send side (Adapter) and
 * the recovery side (Sync) must import from here, never re-derive a hash.
 *
 * Verified against WeKnora 0.7.1:
 *  - Manual knowledge content is transported as a JSON string, stored in the
 *    `metadata` JSON column, and streamed back verbatim by
 *    `GET /knowledge/:id/download` (application/octet-stream). JSON string
 *    transport is lossless for Unicode / CJK / emoji, and WeKnora performs no
 *    newline (CRLF/LF), BOM, or trailing-newline normalization on manual
 *    content. Therefore the canonical form is the identity function.
 *  - File upload dedup (`file_hash`) is MD5 over the raw uploaded bytes, not
 *    sha256. Attachment remote verification therefore uses MD5, while the PKW
 *    local identity (AttachmentRecord.sha256) stays sha256.
 *
 * @module @deepseek-ai/dsh-pkw-weknora/src/fingerprint
 */

import { createHash } from 'node:crypto'

/**
 * Normalize a Manual content string before fingerprinting.
 *
 * Current contract: identity. WeKnora stores manual content verbatim in a JSON
 * string and streams the raw bytes back (no CRLF/LF/BOM/trailing-newline
 * normalization), so the exact content round-trips. `readManualContent` decodes
 * the raw bytes WITHOUT BOM stripping (`TextDecoder` `ignoreBOM: true`) so a
 * leading UTF-8 BOM survives too. Kept as a named seam so any future WeKnora
 * normalization change lands here exactly once, on both send- and recovery-side.
 */
export function canonicalizeRemoteManualContent(content: string): string {
  return content
}

/** Fingerprint of the exact Manual payload sent to / returned from WeKnora. */
export function remoteManualFingerprint(content: string): string {
  return sha256Text(canonicalizeRemoteManualContent(content))
}

/** sha256 of a UTF-8 string, hex-encoded. */
export function sha256Text(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** sha256 of raw bytes, hex-encoded (PKW local binary identity). */
export function sha256Bytes(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** MD5 of raw bytes, hex-encoded — matches WeKnora `file_hash`. */
export function md5Bytes(input: Uint8Array): string {
  return createHash('md5').update(input).digest('hex')
}
