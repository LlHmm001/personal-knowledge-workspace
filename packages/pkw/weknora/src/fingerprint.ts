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
 *    `GET /knowledge/:id/download` (application/octet-stream). `readManualContent`
 *    decodes raw bytes WITHOUT BOM stripping so a leading UTF-8 BOM survives.
 *  - WeKnora runs `secutils.CleanMarkdown` over manual content on BOTH create
 *    and update (it strips a fixed set of XSS patterns). The received content is
 *    therefore ALREADY cleaned; canonicalization below applies the same strip so
 *    the send-side fingerprint equals the recovery-side fingerprint even when a
 *    note contains one of those patterns. The strip is idempotent, so applying it
 *    to the already-cleaned received content is a no-op.
 *  - Manual knowledge is a DRAFT (parse_status "draft", not indexed) unless the
 *    payload carries `status: "publish"`. The Adapter always publishes.
 *  - File upload dedup (`file_hash`) is MD5 over the raw uploaded bytes, not
 *    sha256. Attachment remote verification therefore uses MD5, while the PKW
 *    local identity (AttachmentRecord.sha256) stays sha256.
 *
 * @module @deepseek-ai/dsh-pkw-weknora/src/fingerprint
 */

import { createHash } from 'node:crypto'

/**
 * The XSS patterns WeKnora's `secutils.CleanMarkdown` strips (case-insensitive),
 * replicated EXACTLY so canonicalization matches the real stored content.
 * `.` matches non-newline on both sides (Go regexp default == JS without `s`).
 */
const XSS_PATTERNS: RegExp[] = [
  /<script[^>]*>.*?<\/script>/i,
  /<iframe[^>]*>.*?<\/iframe>/i,
  /<object[^>]*>.*?<\/object>/i,
  /<embed[^>]*>.*?<\/embed>/i,
  /<embed[^>]*>/i,
  /<form[^>]*>.*?<\/form>/i,
  /<input[^>]*>/i,
  /<button[^>]*>.*?<\/button>/i,
  /javascript:/i,
  /vbscript:/i,
  /onload\s*=/i,
  /onerror\s*=/i,
  /onclick\s*=/i,
  /onmouseover\s*=/i,
  /onfocus\s*=/i,
  /onblur\s*=/i,
]

/**
 * Normalize a Manual content string before fingerprinting — must match exactly
 * what WeKnora stores after `secutils.CleanMarkdown`. Used on both the send
 * side and the recovery side (idempotent on already-cleaned content).
 */
export function canonicalizeRemoteManualContent(content: string): string {
  let cleaned = content
  for (const pattern of XSS_PATTERNS) cleaned = cleaned.replace(pattern, '')
  return cleaned
}

/** Fingerprint of the exact Manual payload WeKnora stores for the given content. */
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
