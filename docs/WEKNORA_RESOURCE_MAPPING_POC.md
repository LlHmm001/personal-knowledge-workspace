# WeKnora Resource Mapping POC (Decision Gate)

Status: **source-audit decision**. No code change; real WeKnora source (`/LlHmm9527/WeKnora`) only.

## What `resource://` actually is

WeKnora HAS a first-class internal resource system (NOT just a parser artifact):

- `internal/types/resource.go` — `StoredResource` (table `resources`): `Handle` (22-char, `[0-9A-Za-z_-]{22}`) = stable identity → `resource://<handle>`; `TenantID`, `StorageBackendID`, `Provider`, `PhysicalPath` (internal, `json:"-"`), `Kind` (image/file/audio/video), `MimeType`, `OriginalName`, `Size`, `ContentHash`, `Lifecycle` (persistent/temporary), `State` (active/deleted). Plus `ResourceBinding` (owner_type/owner_id/relation) and `ResourceAccessGrant` (revocable, expiring read capability).
- `internal/application/service/resource.go` — `resourceCatalog`: `Register` / `Resolve` / `ResolvePath` / `Bind` / `MarkDeleted` / `CreateAccessGrant` / `ResolveAccessGrant`.
- `internal/application/service/file/resource_catalog.go` — decorates the FileService: file uploads auto-register a resource and return a `resource://` handle.
- Read route: `GET/HEAD /r/:token` (`router/files.go:349`) resolves `ResolveAccessGrant(token)` → serves the binary. The handle is NOT authorization — a short-lived grant token (~2h) is.
- Frontend (`frontend/src/utils/security.ts:502`, `chatMarkdownRenderer.ts`) treats `img[src^="resource://"]` as "protected" and resolves it via its own security layer (chat renderer path).

## Decision Gate answers

| # | Question | Answer |
|---|---|---|
| 1 | resource:// module | `types/resource.go` + `service/resource.go` + `file/resource_catalog.go` |
| 2 | data model | `StoredResource` (handle, tenant, physical path, kind/mime/hash, lifecycle, state) |
| 3 | upload API (public HTTP) | **NO.** `Register` is a Go service method, called internally by file upload; no HTTP route exposes it. |
| 4 | manual Knowledge can reference `resource://`? | The handle is a valid content string; the CHAT renderer resolves it. But PKW cannot register a resource or mint a grant via HTTP. |
| 5–7 | PKW→Resource register / PKW/WeKnora display | **BLOCKED** — no public register/grant API. |
| 8 | same Attachment multi-Note reuse | Would require a shared resource handle; blocked by #3. |
| 9 | move/rename | handle is path-independent (stable), so resilient **if** it existed. |
| 10 | permission model | `ResourceAccessGrant` (revocable, expiring) + `/r/:token`; handle is not auth. |
| 11 | resource → OCR/parser | Backend resolves resource:// for multimodal (`image_multimodal.go:83`) — but only for resources registered internally. |
| 12 | PDF/file support | `Kind` supports `file`; display semantics frontend-dependent. |
| 13 | Wiki resource behavior | not verified (out of scope). |

## Decision

**RESOURCE MAPPING POC = REJECTED** (PKW-initiated display mapping).

Reason: the resource system is internal. `Register` and `CreateAccessGrant` have **no external HTTP surface**; PKW (HTTP-only) cannot upload a binary into WeKnora as a bare resource or mint a capability token. The only external route (`/r/:token`) requires a pre-existing internal grant. Implementing it would mean hacking the DB / resource directory, which is out of scope and forbidden by the decision rules.

`resource://` is therefore an **internal parser/agent artifact**, not an external asset-reference API.

## Path forward (unchanged)

Markdown canonical + Attachment binary Processing (note-scoped) + PKW Business Knowledge Viewer / A2 federation remain the architecture. The compile→DOCX transport was already rejected (OPTION B text-only). WeKnora backend detail shows `图片附件：<filename>`; PKW viewer renders the image (security-first, prior decision).
