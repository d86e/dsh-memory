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
- **🖥️ Browser UI** — React-based memory management panel with CRUD, layer filtering, and search.
- **🌐 HTTP API** — REST endpoints for programmatic access (`/api/memory/*`).
- **🧩 DSH plugin** — Registers 6 tools: `memory_add`, `memory_search`, `memory_list`, `memory_update`, `memory_remove`, `memory_inject`.
- **📦 Standalone** — Export `MemoryStore`, `EmbeddingClient`, `MemoryService` for direct use.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      DSH Web Server                         │
│  ┌─────────────────┐         ┌─────────────────────────┐   │
│  │  dsh-memory     │         │    dsh-memory-ui        │   │
│  │  (host plugin)  │◄───────►│    (browser panel)      │   │
│  │                 │  HTTP   │                         │   │
│  │  • MemoryStore  │  /api/  │  • React UI             │   │
│  │  • Embedding    │  memory │  • Layer filter         │   │
│  │  • Service      │         │  • Search               │   │
│  └────────┬────────┘         └─────────────────────────┘   │
│           │                                                 │
│  ┌────────▼────────┐                                       │
│  │  SQLite DB      │                                       │
│  │  ~/.dsh/memory.db│                                      │
│  │  • memories     │                                       │
│  │  • memories_fts │                                       │
│  │  • memories_vec │                                       │
│  └─────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install @d86e/dsh-memory
```

**Dependencies:** `better-sqlite3`, `onnxruntime-node`, `sqlite-vec`.

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
const embedding = new EmbeddingClient(); // uses local ONNX model, no config needed
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
    - id: dsh-memory-ui
      name: 'dsh-memory-ui'
      config: {}
```

Create a symlink so Cordis can resolve the UI package:

```bash
ln -s /path/to/dsh-memory/dsh-memory-ui ~/.dsh/profiles/web/node_modules/dsh-memory-ui
```

The plugin auto-registers 6 tools: `memory_add`, `memory_search`, `memory_list`, `memory_update`, `memory_remove`, `memory_inject`. It also exposes `ctx.memory` (a `MemoryService` instance) via `ctx.provide()`.

## HTTP API

The plugin exposes REST endpoints at `/api/memory/*`:

| Method | Path | Description |
|---|---|---|
| GET | `/api/memory/list?limit=100` | List memories |
| POST | `/api/memory/add` | Add memory (`{"content":"...","layer":3,"track":"user"}`) |
| GET | `/api/memory/search?query=记忆&limit=10` | Hybrid search |
| POST | `/api/memory/update` | Update memory (`{"id":1,"changes":{"content":"..."}}`) |
| POST | `/api/memory/remove` | Delete memory (`{"id":1}`) |

### Examples

```bash
# List all memories
curl http://127.0.0.1:3080/api/memory/list

# Add a memory
curl -X POST http://127.0.0.1:3080/api/memory/add \
  -H "Content-Type: application/json" \
  -d '{"content":"Important note","layer":3,"track":"project"}'

# Search (URL-encode Chinese queries)
curl "http://127.0.0.1:3080/api/memory/search?query=%E8%AE%B0%E5%BF%AB&limit=5"
```

## API Reference

### `MemoryStore` (`src/memory-store.js`)

| Method | Description |
|---|---|
| `open(dbPath?)` | Open/connect database (auto-creates directory, loads extensions, initializes schema) |
| `close()` | Close connection |
| `add({ content, layer?, track?, priority?, tags?, source?, embedding? })` | Insert a memory, returns full record |
| `get(id)` | Read by id, returns `null` if not found |
| `list({ layer?, track?, priority?, minPriority?, limit?, offset?, orderBy?, includeDeleted? })` | List memories with filters |
| `update(id, changes)` | Update fields, returns updated record |
| `remove(id, { hard? })` | Delete (soft-delete sets `priority=0`; `hard: true` for physical delete) |
| `ftsSearch(query, options?)` | FTS5 keyword search |
| `vecSearch(vector, options?)` | Vector search (cosine distance) |
| `findSimilar(vector, options?)` | Find similar memories for deduplication |
| `mixedSearch(query, vector, options?)` | Hybrid search, returns `{ results, stats }` |
| `getDatabase()` | Expose raw `Database` instance |

### `EmbeddingClient` (`src/embedding.js`)

Pure local embedding via ONNX. No API key, no network.

```js
const ec = new EmbeddingClient();
const vec = await ec.embedSingle('hello world'); // Float32Array[768], L2-normalized
const [v1, v2] = await ec.embed(['a', 'b']);
```

- **Model:** `nomic-embed-text-v1.5-int8` (768 dimensions, INT8 quantized)
- **Tokenizer:** WordPiece (vocab shipped with package, `models/vocab.txt`)
- **Pooling:** Mean pooling over token hidden states + L2 normalize
- **Config options:** `modelPath`, `dimensions`

### `MemoryService` (`src/service.js`)

| Method | Description |
|---|---|
| `add(content, options?)` | Add memory; auto-generates embedding if `autoEmbed=true` |
| `search(query, options?)` | Hybrid search, returns `{ results, stats }` |
| `get(id)` | Read by id |
| `list(options?)` | List with optional filters |
| `update(id, changes)` | Update fields |
| `remove(id, options?)` | Soft/hard delete |
| `injectForSession(options?)` | Generate memory text block for system prompt injection |

**Default config:**

```js
{
  vectorWeight: 0.6,         // weight for vector search
  ftsWeight: 0.4,            // weight for FTS5 search
  topKVector: 5,             // top-K from vector search
  topKFts5: 5,               // top-K from FTS5 search
  maxInject: 15,             // max memories injected per session
  similarityThreshold: 0.15, // cosine similarity threshold for dedup
  autoEmbed: true,           // auto-generate embeddings on write
}
```

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
| `dimensions` | `768` | Embedding vector dimensions |
| `autoEmbed` | `true` | Auto-generate embeddings on write |

## DSH Tool Reference

| Tool | Parameters | Description |
|---|---|---|
| `memory_add` | `content`, `layer?`, `track?`, `priority?`, `tags?`, `source?` | Store a new memory |
| `memory_search` | `query`, `track?`, `layers?`, `limit?` | Hybrid keyword + semantic search |
| `memory_list` | `layer?`, `track?`, `priority?`, `minPriority?`, `limit?` | List memories with filters |
| `memory_update` | `id`, `changes` | Update an existing memory |
| `memory_remove` | `id`, `hard?` | Delete (soft by default) |
| `memory_inject` | `track?`, `maxInject?` | Preview injected memory text |

## Known Limitations

- **FTS5 Chinese tokenization:** FTS5's default `unicode61` tokenizer does not split CJK characters. The LIKE fallback handles this gracefully, but pure keyword search is less precise for Chinese than semantic search.
- **Cosine similarity threshold:** `similarityThreshold` (default 0.15) means memories with cosine distance ≤ 0.15 (similarity ≥ 0.85) are considered duplicates. Adjust based on your data.
- **Model size:** The ONNX model is ~130 MB (git-lfs tracked). First install requires downloading unless the repo is cloned with LFS.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Link to DSH profile
ln -s /path/to/dsh-memory ~/.dsh/profiles/web/node_modules/dsh-memory
ln -s /path/to/dsh-memory/dsh-memory-ui ~/.dsh/profiles/web/node_modules/dsh-memory-ui
```

## License

MIT
