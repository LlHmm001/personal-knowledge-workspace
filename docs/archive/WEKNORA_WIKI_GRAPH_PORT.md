# WeKnora Wiki / Knowledge Graph → PKW Port (audit record)

Status: source audit (verified from `/LlHmm9527/WeKnora` backend). PKW consumes the **same WeKnora-generated result** via API — no iframe, no second generator, no PKW-side canonical Wiki/Graph store. This doc is the D1/E1 source-audit deliverable.

## Identity model (PART F)

```
Note (NoteId)        ↕  Note KnowledgeId        (manual Markdown text)
Attachment (AttachmentId) ↕ Attachment KnowledgeId (file binary + parser)
Wiki pages / Graph nodes   = WeKnora-derived knowledge (NOT Proposition / Memory Relation)
```

Knowledge ↔ PKW entity mapping already exists as durable `mappings` (NoteId↔KnowledgeId, AttachmentId↔KnowledgeId) in the PKW sync service.

## Wiki — backend routes (verified)

| route | method | purpose |
|---|---|---|
| `/knowledgebase/{kb_id}/wiki/pages` | GET | list pages (index/category tree) |
| `/knowledgebase/{kb_id}/wiki/pages` | POST | create page |
| `/knowledgebase/{kb_id}/wiki/pages/{slug}` | GET | get page (full markdown content) |
| `/knowledgebase/{kb_id}/wiki/pages/{slug}` | PUT | update page |
| `/knowledgebase/{kb_id}/wiki/folders` | GET | list folder tree |
| `/knowledgebase/{kb_id}/wiki/folders` | POST | create folder |
| `/knowledgebase/{kb_id}/wiki/folders/{folder_id}` | PUT/DELETE | update/delete folder |
| `/knowledgebase/{kb_id}/wiki/move-page` | PUT | move page |
| `/knowledgebase/{kb_id}/wiki/revisions/{slug}` | GET | list revisions |
| `/knowledgebase/{kb_id}/wiki/graph` | GET | knowledge graph (mode=overview\|ego, center, depth, types, limit) |

`handler/wiki_page.go` (NewWikiPageHandler) is the handler entry; `types/wiki_page.go` defines the models.

## Wiki data model (`types/wiki_page.go`)

`WikiPage`: `id`, `tenant_id`, `knowledge_base_id`, `slug`, `title`, `page_type` (summary/entity/concept/index/log/synthesis/comparison), `status` (draft/published/archived), `content` (full markdown), `summary` (one-line), `aliases`, `parent_slug`, `folder_id`, `category_path` (breadcrumb array), `wiki_path`, `depth`, `sort_order`.

`WikiFolder`/`WikiFolderNode`: folder tree; `WikiPageRevision`: revision history.

## Graph data model

`WikiGraphData` (nodes + edges); modes `overview` (top-N most-connected) / `ego` (neighborhood around `center`, BFS `depth` 1–3); `types` allow-list; `limit` (default 500, max 2000). `WikiGraphNode`/`WikiGraphEdge` in `types/wiki_page.go`.

Node `page_type` legend = 摘要(summary) / 实体(entity) / 概念(concept) / 综合(synthesis) / 对比(comparison).

## Knowledge summary / parser / reparse (verified)

- Knowledge model (`types/knowledge.go`): `Description` (`json:"description"`) = generated summary; `SummaryStatus` (`json:"summary_status"`) = none/pending/processing/completed/failed.
- Reparse: `POST /knowledge/{id}/reparse` (per-knowledge) and `POST /knowledge/batch-reparse` (batch). **PKW client already exposes `reparseKnowledge(knowledgeId)`** → so an Attachment Inspector "重新解析" action can call the official reparse API (no delete/re-upload hack).
- Parser engine selection: `ChunkingConfig.ResolveParserEngine(fileType)` (per-file-type rules) → `resolveDocReader` (server-side). Changing `ParserEngineRules` affects **future parsing**; for existing knowledge use the official `reparse` endpoint (PKW does not auto-reparse; a reparse action is the correct, non-hack path).

## PKW client gap

Current `packages/pkw/weknora/src/index.ts` has **no** Wiki/Graph methods, and `Knowledge` lacks `description`/`summary_status`. To consume the same generated result, PKW needs to add:
- `Knowledge.description` / `Knowledge.summary_status` (+ expose in `getKnowledge`).
- Wiki: `listWikiPages(kbId)`, `getWikiPage(kbId, slug)`, `listWikiFolders(kbId)`, `searchWikiPages(kbId, q)`, `getWikiGraph(kbId, {mode, center, depth, types, limit})`.
- (Read-only parity is the target; write endpoints are out of scope unless the user requests editing.)

## Functional parity target (D5/E2)

Wiki: page search, index (page_type=index), logs (page_type=log), knowledge/summary toggle, category tree + counts, generated summary pages, wiki links, page navigation, generation status. Graph: page search, type legend, fit screen, hide relations, full-library overview, node count, pan/zoom, node click → wiki page, page↔full graph toggle, PKW source deep links (KnowledgeId→NoteId/AttachmentId via durable mapping).

## Offline / cache

Wiki/Graph go through the existing view cache-first + single-flight + `viewSeq` stale guard. WeKnora offline → "WeKnora 暂不可用" (or cached projection + stale badge); Notes/Tasks unaffected.
