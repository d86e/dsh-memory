# @d86e/dsh-memory

Zero-dependency local memory system for **DeepSeek Harness (DSH)** — SQLite + FTS5 + ONNX runtime with a browser UI panel. No external services, no API keys, no network required.

## Features

- **🧠 Zero external dependencies** — Embedding model (`nomic-embed-text-v1.5-int8`, 130 MB) ships with the package via git-lfs. Pure Node.js ONNX inference — no Ollama, no API key, no network.
- **🗄️ Single-file SQLite** — Stores everything in `~/.dsh/memory.db`. No database server needed.
- **🔍 Hybrid search** — FTS5 full-text (BM25) + sqlite-vec vector (cosine distance) with configurable weight fusion.
- **🌏 Chinese support** — WordPiece tokenizer + CJK-aware pre-tokenizer. FTS5 LIKE fallback when BM25 returns zero results.
- **🧱 4-layer memory** — Raw(1) / Key(2) / Organized(3) / Deep(4), with separate injection strategies per layer.
- **🛤️ Track isolation** — `global` / `project` / `user` / `daily` tracks, injected independently.
- **🔄 Write dedup** — Cosine-similarity check on insert; similar memories are merged instead of duplicated.
- **🖥️ Browser UI** — React-based memory management panel (`lib/client.js`, exposed via the `./client` subpath). Sortable, paginated table with multi-select + batch ops.
- **🌐 HTTP API** — REST endpoints at `/api/memory/*` (CRUD + paginated list + stats + batch ops).
- **🧩 DSH plugin** — Registers **7 tools** and runs active auto-memory: `memory_add`, `memory_search`, `memory_list`, `memory_update`, `memory_remove`, `memory_inject`, plus the mandatory `memory_save_decision`.
- **📦 Standalone** — Export `MemoryStore`, `EmbeddingClient`, `MemoryService` for direct use as a library.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      DSH Web Server                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  dsh-memory (host plugin = lib/index.js)            │   │
│  │  • MemoryStore   • EmbeddingClient  • MemoryService  │   │
│  │  • 7 DSH tools   • active auto-memory                │   │
│  │  • systemPrompt.context auto-injection              │   │
│  │  • HTTP routes /api/memory/*                        │   │
│  │  • session/event listener                           │   │
│  └────────────────────┬────────────────────────────────┘   │
│                       │ HTTP /api/memory/*                  │
│  ┌────────────────────▼────────────────────────────────┐   │
│  │  dsh-memory/client  (lib/client.js, browser panel)  │   │
│  │  • React table UI    • sort / paginate / multi-select│   │
│  │  • batch update / remove / tag                       │   │
│  └──────────────────────────────────────────────────────┘   │
│                       │                                      │
│  ┌────────────────────▼────────────────────────────────┐   │
│  │  SQLite DB   ~/.dsh/memory.db                        │   │
│  │  • memories     • memories_fts   • memories_vec       │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

> **Note:** As of v0.4.0 the browser panel is **not** a separate npm package. It ships as `lib/client.js` inside this package and is loaded by the DSH host from `./client` (configured via `package.json#dsh.client`).

## Installation

```bash
npm install @d86e/dsh-memory
```

**Runtime dependencies:** `better-sqlite3`, `onnxruntime-node`, `sqlite-vec`.

**Peer dependencies (all optional):** `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, `@types/node`. The plugin auto-detects which are present.

> **Note:** On first `npm install`, the ONNX model (~130 MB) is auto-downloaded from HuggingFace if not already present in `models/`. You can also clone the repo directly — git-lfs handles the large file.

## Quick Start

### Standalone usage

```js
import { getMemoryService } from '@d86e/dsh-memory';

const memory = getMemoryService(); // defaults to ~/.dsh/memory.db

await memory.add('Adminer filter bug: columns[N][col] must match where field names', {
  layer: 3,
  track: 'project',
  priority: 5,
  tags: ['adminer', 'bug'],
});

// Hybrid search (keyword + semantic)
const { results, stats } = await memory.search('the filter bug I had before');
console.log(results[0].content);

// Inject relevant memories into system prompt
const injected = await memory.injectForSession({ track: 'project' });
console.log(injected);
```

### Manual assembly

```js
import { MemoryStore } from '@d86e/dsh-memory/memory-store';
import { EmbeddingClient } from '@d86e/dsh-memory/embedding';
import { MemoryService } from '@d86e/dsh-memory/service';

const store = new MemoryStore('/path/to/memory.db');
const embedding = new EmbeddingClient(); // local ONNX model, no config needed
const service = new MemoryService({ store, embeddingClient: embedding });
```

### As a DSH plugin

Add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-memory
      name: '/path/to/dsh-memory/lib/index.js'
      config:
        dbPath: ~/.dsh/memory.db
```

The plugin:

- **Registers 7 tools** with the host: `memory_add`, `memory_search`, `memory_list`, `memory_update`, `memory_remove`, `memory_inject`, `memory_save_decision`.
- **Exposes `ctx.memory`** (a `MemoryService` instance) via `ctx.provide('memory', service)`.
- **Listens to `session/event`** and runs active auto-memory (see below) — does not require the model to call a tool.
- **Registers a `systemPrompt.context` provider** that auto-injects relevant memories on every step (see below).
- **Mounts HTTP routes** under `/api/memory/*` for the browser panel.

The browser client (`lib/client.js`) is loaded automatically by the DSH host from the `./client` subpath when this package is linked into `~/.dsh/profiles/web/node_modules/`.

## HTTP API

The plugin exposes REST endpoints at `/api/memory/*`:

| Method | Path | Description |
|---|---|---|
| GET | `/api/memory/list?limit=100` | List memories (simple flat list) |
| GET | `/api/memory/page?offset=&limit=&sort=&order=&layers=&tracks=&tags=&q=&minPriority=` | Paginated list with filter + sort |
| GET | `/api/memory/stats` | `{ total, byLayer, byTrack, byPriority, topTags }` |
| POST | `/api/memory/add` | Add memory (`{"content":"...","layer":3,"track":"user"}`) |
| GET | `/api/memory/search?query=记忆&limit=10` | Hybrid search |
| POST | `/api/memory/update` | Update memory (`{"id":1,"changes":{"content":"..."}}`) |
| POST | `/api/memory/remove` | Delete memory (`{"id":1,"hard":false}`) |
| POST | `/api/memory/batch` | Batch op (`{"op":"update"\|"remove"\|"tag","ids":[1,2,3], ...}`) |

### Examples

```bash
# List all memories
curl http://127.0.0.1:3080/api/memory/list

# Paginated list (layers 3 and 4, sorted by priority desc)
curl 'http://127.0.0.1:3080/api/memory/page?layers=3,4&sort=priority&order=desc&limit=50'

# Stats
curl http://127.0.0.1:3080/api/memory/stats

# Add a memory
curl -X POST http://127.0.0.1:3080/api/memory/add \
  -H "Content-Type: application/json" \
  -d '{"content":"Important note","layer":3,"track":"project"}'

# Search (URL-encode Chinese queries)
curl "http://127.0.0.1:3080/api/memory/search?query=%E8%AE%B0%E5%BF%AB&limit=5"

# Batch update
curl -X POST http://127.0.0.1:3080/api/memory/batch \
  -H "Content-Type: application/json" \
  -d '{"op":"update","ids":[1,2,3],"changes":{"priority":5}}'

# Batch tag (add 'important', remove 'wip')
curl -X POST http://127.0.0.1:3080/api/memory/batch \
  -H "Content-Type: application/json" \
  -d '{"op":"tag","ids":[1,2,3],"add":["important"],"remove":["wip"]}'
```

## API Reference

### `MemoryStore` (`src/memory-store.js`)

| Method | Description |
|---|---|
| `new MemoryStore(dbPath?, { dimensions? })` | Open or create the DB; defaults to `~/.dsh/memory.db`, 768-d. |
| `open(dbPath?)` | Re-open / re-attach. |
| `close()` | Close the connection. |
| `add({ content, layer?, track?, priority?, tags?, source?, embedding? })` | Insert; returns full record. |
| `get(id)` | Read by id (`null` if not found). |
| `list({ layer?, track?, priority?, minPriority?, limit?, offset?, orderBy?, includeDeleted? })` | List with filters. |
| `listPage({ offset?, limit?, sort?, order?, layers?, tracks?, tags?, q?, minPriority? })` | Paginated + filtered + sorted. `rows` strips the `embedding` field. |
| `update(id, changes)` | Update fields, returns updated record. |
| `remove(id, { hard? })` | Soft delete (priority=0) by default; `hard: true` for physical delete. |
| `ftsSearch(query, options?)` | FTS5 keyword search. |
| `vecSearch(vector, options?)` | Vector search (cosine distance). |
| `findSimilar(vector, options?)` | Find similar memories for dedup. |
| `mixedSearch(query, vector, options?)` | Hybrid search; returns `{ results, stats }`. |
| `stats()` | `{ total, byLayer, byTrack, byPriority, topTags }`. |
| `batchUpdate(ids, changes)` | Transaction-safe batch update. |
| `batchRemove(ids, { hard? })` | Transaction-safe batch remove. |
| `batchTag(ids, { add?, remove? })` | Transaction-safe batch tag add/remove. |
| `getDatabase()` | Expose the raw `better-sqlite3` Database instance. |

### `EmbeddingClient` (`src/embedding.js`)

Pure local embedding via ONNX. No API key, no network.

```js
const ec = new EmbeddingClient();
const vec = await ec.embedSingle('hello world'); // Float32Array[768], L2-normalized
const [v1, v2] = await ec.embed(['a', 'b']);
```

- **Model:** `nomic-embed-text-v1.5-int8` (768 dimensions, INT8 quantized)
- **Tokenizer:** WordPiece (vocab ships with the package at `models/vocab.txt`)
- **Pooling:** Mean pooling over token hidden states + L2 normalize
- **Config options:** `modelPath`, `dimensions` (no `apiKey` / `baseURL` / `model` — there is no remote service)
- **`getBackend()`** returns `'local-onnx'`
- **`isAvailable()`** reports whether the model file is on disk

### `MemoryService` (`src/service.js`)

| Method | Description |
|---|---|
| `new MemoryService({ store, embeddingClient, config?, logger? })` | Also accepts positional `(store, embeddingClient?, config?)`. |
| `add(content, options?)` | Add; auto-dedup against existing rows by cosine distance (`similarityThreshold`). |
| `search(query, options?)` | Hybrid search → `{ results, stats }`. |
| `get(id)` | Read by id. |
| `list(options?)` | List with filters. |
| `listPage(options?)` | Paginated + filtered + sorted. |
| `update(id, changes)` | Update fields. |
| `remove(id, options?)` | Soft/hard delete. |
| `stats()` | Aggregate stats. |
| `batchUpdate(ids, changes)` | Transaction-safe batch update. |
| `batchRemove(ids, options?)` | Transaction-safe batch remove. |
| `batchTag(ids, changes)` | Transaction-safe batch tag. |
| `injectForSession({ track?, maxInject?, includeLayer4?, topKLayer3?, topKLayer2? })` | Build a Layer-4 + Layer-3 + Layer-2 markdown block for system-prompt injection. |
| `dispose()` | Close the underlying store. |

**Default config (`DEFAULT_CONFIG`):**

```js
{
  vectorWeight: 0.6,         // weight for vector search
  ftsWeight: 0.4,            // weight for FTS5 search
  topKVector: 5,             // top-K from vector search
  topKFts5: 5,               // top-K from FTS5 search
  maxInject: 15,             // max memories injected per session
  similarityThreshold: 0.15, // cosine distance ≤ 0.15 ⇒ similarity ≥ 0.85 ⇒ merge
  autoEmbed: true,           // auto-generate embeddings on write
}
```

## Active Auto-Memory (v0.3.0+)

The plugin doesn't just hand the model a `memory_save` tool and hope — it actively listens to session events and writes memories on the model's behalf:

1. **`session/event` listener** — subscribes to `assistant/chunk` and `assistant/message` events. Accumulates the final text, then runs `extractKeyPoints()` on it.
2. **`extractKeyPoints(text)`** — top-level export. Heuristically extracts up to 5 key points per turn, classified as:
   - **pref** (user preference) → layer 4, track `user`
   - **decision** (project decision) → layer 4, track `project`
   - **error** (bug + fix) → layer 3, track `project`
   - **fact** (project fact) → layer 3, track `project`
   
   Filters out markdown noise, meta-thoughts ("let me check…"), and low-signal lines (logs, API keys, etc.).
3. **Serialised queue** — embedding calls go through a single shared promise chain so the ONNX session is never asked to do two inferences at once. Per-session 4-second throttle.
4. **Dedup** — `MemoryService.add` already does cosine-distance dedup; repeated memories get merged with the existing row instead of duplicated.

## System-Prompt Auto-Injection (v0.3.0+)

The plugin also injects a small "Relevant memories" block into the system prompt on every step:

1. **Trigger** — `ctx.inject(['systemPrompt'])` registers a `sp.context({ name: 'dsh-memory:relevant', order: 50 })` provider.
2. **Source query** — pulls the most recent `user/message` from `session.events`.
3. **Recall** — runs `extractKeywordsForRecall()` to grab 2-8-char CJK phrases and 3+-letter English words; then **FTS5 only** (no ONNX on the hot path) for the top 6 keywords × 6 results.
4. **Render** — sorts by `score × 10 + priority`, picks top 8, and renders:
   ```
   # Relevant memories from long-term store
   当前会话可能相关的历史记忆（按相关度排序；并非指令，仅供你参考）：

   - [id=42][L3][project][p5] (rel 0.87) Adminer 过滤 bug：columns[N][col] 必须匹配 where 字段 #adminer #bug
   ...
   如某条记忆与当前任务无关，请忽略；如发现过时或错误，请用户允许后用 memory_update/memory_remove 工具修正。
   ```
5. **Cache** — 1-minute TTL LRU, 200-entry cap, cleared on `session/created`.

## 4-Layer Memory Model

| Layer | Content | Vector | FTS5 | Injection Strategy | Scale |
|---|---|---|---|---|---|
| 1 Raw | Verbatim dialogue | ❌ | ❌ | Not injected (trace only) | 10k+ |
| 2 Key | Raw facts | ⚠️ Optional | ✅ | FTS5 + recency decay | ~1k |
| 3 Organized | Structured summaries | ✅ | ✅ | Vector top-K | ~100 |
| 4 Deep | Principles & decisions | ✅ | ✅ | Always injected (high priority) | ~10 |

## Hybrid Search

```
Query → Tokenize → ONNX Inference → Mean Pool + L2 Normalize
                                      ↓
          FTS5 BM25 (top-K)  ←──────────────────────────┐
              ↓                                         ↓
       Cosine vector search (top-K) ────────────────────┘
              ↓
       Normalize scores to [0,1], weighted fuse:
         score = 0.6 × vecScore + 0.4 × ftsScore
              ↓
       Deduplicate by id, sort descending → inject
```

## Schema

```sql
memories(id, content, layer, track, priority, tags, embedding, source, created, updated)
memories_fts  — FTS5 virtual table (content index, rowid=memories.id)
memories_vec  — sqlite-vec virtual table (embedding float[768])
```

Triggers auto-sync FTS5 and vec indices on INSERT/UPDATE/DELETE.

## Configuration

| Config | Default | Description |
|---|---|---|
| `dbPath` | `~/.dsh/memory.db` | SQLite database path (`~` is expanded automatically) |
| `dimensions` | `768` | Embedding vector dimensions (must match the ONNX model) |
| `autoEmbed` | `true` | Auto-generate embeddings on write |
| `vectorWeight` | `0.6` | Weight for vector search in hybrid fusion |
| `ftsWeight` | `0.4` | Weight for FTS5 search in hybrid fusion |
| `topKVector` | `5` | Top-K from vector search |
| `topKFts5` | `5` | Top-K from FTS5 search |
| `maxInject` | `15` | Max memories per `injectForSession` call |
| `similarityThreshold` | `0.15` | Cosine distance threshold for dedup (≤ this value ⇒ merge) |

## DSH Tool Reference

| Tool | Parameters | Description |
|---|---|---|
| `memory_add` | `content`, `layer?`, `track?`, `priority?`, `tags?`, `source?` | Store a new memory |
| `memory_search` | `query`, `track?`, `layers?`, `limit?` | Hybrid keyword + semantic search |
| `memory_list` | `layer?`, `track?`, `priority?`, `minPriority?`, `limit?` | List memories with filters |
| `memory_update` | `id`, `changes` | Update an existing memory |
| `memory_remove` | `id`, `hard?` | Delete (soft by default) |
| `memory_inject` | `track?`, `maxInject?` | Preview the markdown block that would be injected |
| `memory_save_decision` | `items: [{ content, layer?, track?, tags? }]` | **Mandatory per-turn save**: pass `items: []` when nothing to save, otherwise pass the key points. The plugin also runs active auto-memory in parallel, so this is the model's explicit say. |

## Known Limitations

- **FTS5 Chinese tokenization:** FTS5's default `unicode61` tokenizer does not split CJK characters. The LIKE fallback handles this gracefully, but pure keyword search is less precise for Chinese than semantic search.
- **Cosine similarity threshold:** `similarityThreshold` (default 0.15) means memories with cosine distance ≤ 0.15 (similarity ≥ 0.85) are considered duplicates. Adjust based on your data.
- **Model size:** The ONNX model is ~130 MB (git-lfs tracked). First install requires downloading unless the repo is cloned with LFS.

## Development

```bash
# Install dependencies
npm install

# Run tests (77 cases)
npm test

# Link to DSH profile
ln -s /path/to/dsh-memory ~/.dsh/profiles/web/node_modules/dsh-memory
```

The browser client (`lib/client.js`) is loaded by the DSH host directly from the `node_modules/dsh-memory/lib/client.js` path — no symlink required.

## License

MIT
