/** Explicit keyword mode over canonical, authorized-space content. No remote ranking fusion. */
export interface LocalDocument { id: string; kind: 'note' | 'attachment'; title: string; path?: string; content: string }
const stopWords = new Set(['的','了','和','是','我','你','请','帮','什么','怎么','the','a','an','and','or','is','to','of'])
export function localKeywordSearch(query: string, documents: LocalDocument[], limit: number): unknown[] {
  const normalized = query.normalize('NFKC').trim().toLocaleLowerCase()
  if (!normalized) return []
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  const terms = [...new Set([...segmenter.segment(normalized)].filter(s => s.isWordLike).map(s => s.segment).filter(s => !stopWords.has(s)))].slice(0, 32)
  if (!terms.length) return []
  return documents.map(document => {
    const title = document.title.normalize('NFKC').toLocaleLowerCase(), content = document.content.normalize('NFKC').toLocaleLowerCase()
    let score = 0, matches = 0
    for (const term of terms) {
      if (title.includes(term)) { score += 4; matches++ }
      else if (content.includes(term)) { score += 1; matches++ }
    }
    if (!matches) return null
    if (title.includes(normalized)) score += 8
    else if (content.includes(normalized)) score += 4
    score += matches / terms.length
    // Use original bytes for display, not compatibility-normalized offsets.
    const display = document.content.replace(/\s+/g, ' ')
    const first = terms.map(term => display.toLocaleLowerCase().indexOf(term)).filter(at => at >= 0).sort((a, b) => a - b)[0] ?? 0
    const start = Math.max(0, first - 60), snippet = (start ? '…' : '') + display.slice(start, start + 220) + (display.length > start + 220 ? '…' : '')
    return { score, key: document.kind + ':' + document.id, result: {
      remote: { content: snippet, snippet, bestEvidence: snippet ? [snippet] : [], title: document.title, score },
      local: { entityType: document.kind, entityId: document.id, title: document.title, relativePath: document.path, folder: document.path?.split('/').slice(0, -1).join('/') ?? '', matchReason: 'note' },
    } }
  }).filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, limit).map(item => item.result)
}
