import { describe, expect, it } from 'vitest'
import { buildProcessingKbContract, classifyProcessingKbDrift, processingContractFingerprint } from '../src/processing-kb-contract.ts'

describe('processing KB contract drift', () => {
  const base = { chunking_config: { chunk_size: 512, parser_engine_rules: [{ engine: 'simple', file_types: ['txt'] }] }, vlm_config: { enabled: true }, embedding_model_id: 'emb-1', summary_model_id: 'sum-1' }

  it('embedding_model_id drift → REBUILD_REQUIRED', () => {
    const actual = { ...base, embedding_model_id: '' }
    expect(classifyProcessingKbDrift(buildProcessingKbContract(base), buildProcessingKbContract(actual))).toBe('rebuild_required')
  })

  it('summary_model_id drift → REBUILD_REQUIRED', () => {
    const actual = { ...base, summary_model_id: 'sum-old' }
    expect(classifyProcessingKbDrift(buildProcessingKbContract(base), buildProcessingKbContract(actual))).toBe('rebuild_required')
  })

  it('chunking_config-only drift → MUTABLE_UPDATE', () => {
    const actual = { ...base, chunking_config: { chunk_size: 999 } }
    expect(classifyProcessingKbDrift(buildProcessingKbContract(base), buildProcessingKbContract(actual))).toBe('mutable_update')
  })

  it('vlm_config-only drift → MUTABLE_UPDATE', () => {
    const actual = { ...base, vlm_config: { enabled: false } }
    expect(classifyProcessingKbDrift(buildProcessingKbContract(base), buildProcessingKbContract(actual))).toBe('mutable_update')
  })

  it('no drift → NONE', () => {
    expect(classifyProcessingKbDrift(buildProcessingKbContract(base), buildProcessingKbContract(base))).toBe('none')
  })

  it('fingerprint covers embedding_model_id + summary_model_id', () => {
    const fp1 = processingContractFingerprint(base)
    const fp2 = processingContractFingerprint({ ...base, embedding_model_id: 'emb-2' })
    const fp3 = processingContractFingerprint({ ...base, summary_model_id: 'sum-2' })
    expect(fp1).not.toBe(fp2)
    expect(fp1).not.toBe(fp3)
  })
})
