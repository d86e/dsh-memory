# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-08-30

### Changed
- **Embedding backend**: `EmbeddingClient` is now **local ONNX** (`nomic-embed-text-v1.5-int8`, 768-dim). No API key, no network, no Ollama. The previous DeepSeek/OpenAI HTTP client is removed. Model file ships with the package via git-lfs.
- **Removed `dsh-memory-ui` package**: browser client merged into this package as `lib/client.js` (exposed via the `./client` subpath export). `dsh-memory-ui` is no longer a separate npm entry — the DSH host loads it directly from the `lib/client.js` it already sees on disk.
- **Tooling surface**: `package.json#exports` now exposes five subpaths: `.`, `./client`, `./memory-store`, `./embedding`, `./service`.
- **TypeScript surface**: `lib/index.d.ts` rewritten to reflect the real v0.3.0/v0.4.0 API (`VEC_DIMENSIONS = 768`, `inject` 4 items, 7 tools, `listPage`/`stats`/`batch*`, `logger` field, `extractKeyPoints`, `extractKeywordsForRecall`). New `src/*.d.ts` files back the three library subpath exports.
- **Schema**: `Config` schema no longer includes `apiKey` / `baseURL` / `model` / `timeout` (those were for the removed HTTP client). Added `dimensions` (default 768).
- **README**: updated to match the merged UI and v0.3.0+/v0.4.0 features.

### Removed
- `dsh-memory-ui/lib/index.js` and its `package.json` (the bundler entry). Browser client now lives at `lib/client.js`.

### Fixed
- `memory_save_decision` and `memory_inject` tool definitions are now consistent with the rest of the file.
- UI: removed redundant delete confirmation modal; toolbar height normalised; `PAGE_SIZE` raised to 500.

## [0.3.0] — 2026-08-28

### Added
- **Local ONNX embedding**: `nomic-embed-text-v1.5-int8` (INT8 quantized, 768-d) ships with the package. Replaces external API dependency entirely. ~130 MB download via git-lfs.
- **CJK tokenizer**: WordPiece with a CJK-aware pre-tokenizer; FTS5 LIKE fallback for Chinese queries.
- **`memory_save_decision` tool** (mandatory per-turn): the model is expected to call this every turn with a batch of key points (or `items: []` when nothing to save).
- **Active auto-memory**: plugin subscribes to `session/event` (`assistant/chunk` + `assistant/message`), runs `extractKeyPoints()` on the final text, and saves the top 5 to the store without the model having to call a tool. Per-session 4-second throttle; serialised embedding queue to avoid ONNX session contention.
- **System-prompt auto-injection** via `systemPrompt.context` provider: every step the plugin pulls FTS5 keyword hits for the most recent user message (no ONNX on the hot path) and renders a small "Relevant memories" block at order 50. 1-minute LRU cache, 200-entry cap.
- **HTTP API**:
  - `GET /api/memory/page` — paginated list with filter + sort
  - `GET /api/memory/stats` — counts by layer/track/priority + top tags
  - `POST /api/memory/batch` — `{ op: 'update' | 'remove' | 'tag', ... }` for batch operations
- **`MemoryStore.listPage`**: paginated query with layers/tracks/tags/keyword filter and arbitrary column sort. Returns `{ rows, total, offset, limit }`. `rows` strips the `embedding` field to reduce bandwidth.
- **`MemoryStore.stats`**: `total` + `byLayer` + `byTrack` + `byPriority` + `topTags`.
- **`MemoryStore.batchUpdate` / `batchRemove` / `batchTag`**: transaction-safe batch helpers; `batchTag` accepts `{ add, remove }` and merges into the existing tag array.
- **`MemoryService.batchUpdate` / `batchRemove` / `batchTag` / `listPage` / `stats`**: thin pass-through wrappers.
- **Logger injection**: `MemoryService` now accepts a `logger` option (`{ info?, warn?, debug?, error? }`). `console.warn` calls during dedup/embedding failures are routed through it.
- **`extractKeyPoints(rawText, opts?)`**: top-level export, used by active auto-memory and unit-tested. Categorises extracted points as `pref` / `decision` / `error` / `fact` and assigns layer/track automatically.
- **`extractKeywordsForRecall(text, max=6)`**: top-level export, used by system-prompt injection. Pulls 2-8-char CJK phrases and 3+-letter English words.
- **Table UI** (`dsh-memory-ui/lib/client.js`): sortable, paginated, multi-select table with batch-update / batch-remove / batch-tag buttons. 200-entries per page; sticky header; 4 color-coded layer chips.
- **77 unit tests** (up from 33 in v0.1.0) covering `MemoryStore`, `MemoryService`, embedding integration, `extractKeyPoints`, `extractKeywordsForRecall`, and `listPage` / `stats` / batch operations.

### Changed
- `EmbeddingClient` constructor: no longer accepts `apiKey`, `baseURL`, `model`, `timeout`. Accepts only `{ modelPath?, dimensions? }`. Returns `getBackend() === 'local-onnx'`.
- `MemoryStore` constructor: now accepts an `options` object (`{ dimensions? }`) as a second argument.
- `MemoryService` constructor: now also accepts `{ store, embeddingClient, config, logger }` single-options form.
- `inject` is now `['tools', 'webServer', 'sessions', 'systemPrompt']` (up from `['tools']`).
- FTS5 `ftsSearch` results now include `tags` and a normalised `score` field.

### Notes
- v0.3.0 is a breaking change versus v0.1.0:
  - `EmbeddingClient(config)` signature changed
  - The external `apiKey` / `baseURL` / `model` schema fields are gone
  - HTTP API gained three new routes (`/page`, `/stats`, `/batch`) but old ones are unchanged

## [0.1.0] — 2026-08-24

### Added
- `MemoryStore`: SQLite storage with FTS5 full-text search + sqlite-vec vector search
- `EmbeddingClient`: DeepSeek/OpenAI-compatible embedding API client
- `MemoryService`: High-level CRUD + mixed search + session injection
- DSH Cordis plugin: `memory_add`, `memory_search`, `memory_list`, `memory_update`, `memory_remove`
- 4-layer memory architecture (Raw/Key/Organized/Deep)
- 4-track isolation (global/project/user/daily)
- Soft delete with `priority=0` + `includeDeleted` option for search
- Transaction-safe write operations (`add`, `update`)
- Input validation (layer, track, priority ranges; orderBy whitelist)
- TypeScript type definitions (`lib/index.d.ts`)
- `dispose()` lifecycle method for plugin cleanup
- 33 unit tests with 90%+ coverage

### Technical Details
- Default DB path: `~/.dsh/memory.db`
- Embedding dimensions: 1024 (DeepSeek `deepseek-embed`)
- Mixed search weighting: 60% vector + 40% FTS5 (configurable)
- Requires: Node.js >= 18, SQLite 3.51+
