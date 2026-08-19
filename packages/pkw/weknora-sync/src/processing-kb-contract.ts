/**
 * Processing KB contract — the pure decision layer for mirroring the main KB's
 * processing-relevant config into the internal Processing KB.
 *
 * MUTABLE fields (chunking_config / vlm_config) can be fixed by updateKnowledgeBase.
 * CREATE-ONLY fields (embedding_model_id / summary_model_id) are ignored by
 * WeKnora on PUT (curl-proven), so a drift there requires a CONTROLLED REBUILD.
 *
 * @module @deepseek-ai/dsh-pkw-weknora-sync/processing-kb-contract
 */

import { sha256Text } from '@deepseek-ai/dsh-pkw-weknora'

export interface ProcessingKbContract {
  chunkingConfig: unknown
  vlmConfig: unknown
  embeddingModelId: string
  summaryModelId: string
}

export function buildProcessingKbContract(kb: Record<string, unknown>): ProcessingKbContract {
  return {
    chunkingConfig: kb.chunking_config ?? null,
    vlmConfig: kb.vlm_config ?? null,
    embeddingModelId: typeof kb.embedding_model_id === 'string' ? kb.embedding_model_id : '',
    summaryModelId: typeof kb.summary_model_id === 'string' ? kb.summary_model_id : '',
  }
}

export type ProcessingKbDrift = 'none' | 'mutable_update' | 'rebuild_required'

/** Classify how an existing Processing KB differs from the desired (main-KB) contract. */
export function classifyProcessingKbDrift(desired: ProcessingKbContract, actual: ProcessingKbContract): ProcessingKbDrift {
  const createOnlyChanged =
    desired.embeddingModelId !== actual.embeddingModelId ||
    desired.summaryModelId !== actual.summaryModelId
  if (createOnlyChanged) return 'rebuild_required'
  const mutableChanged =
    JSON.stringify(desired.chunkingConfig) !== JSON.stringify(actual.chunkingConfig) ||
    JSON.stringify(desired.vlmConfig) !== JSON.stringify(actual.vlmConfig)
  if (mutableChanged) return 'mutable_update'
  return 'none'
}

/** Fingerprint of the FULL processing contract (covers mutable + create-only). */
export function processingContractFingerprint(kb: Record<string, unknown>): string {
  return sha256Text(JSON.stringify(buildProcessingKbContract(kb)))
}
