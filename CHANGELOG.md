# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
