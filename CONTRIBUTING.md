# Contributing to dsh-memory

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/d86e/dsh-memory.git
cd dsh-memory
npm install
npm test
```

## Project Structure

```
src/
  memory-store.js   # SQLite + FTS5 + sqlite-vec core
  embedding.js      # DeepSeek/OpenAI embedding API client
  service.js        # High-level memory service
lib/
  index.js          # DSH Cordis plugin entry point
  index.d.ts        # TypeScript type definitions
tests/              # Node.js built-in test runner
docs/               # Design documentation
```

## Adding Tests

Tests use Node.js built-in `node:test`. Add new tests in the corresponding file under `tests/`.

```bash
npm test
```

## Code Style

- ESM only (`import`/`export`)
- Chinese comments are fine (primary audience is Chinese-speaking DSH users)
- No external dev dependencies beyond what's needed

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation only
- `test:` test changes
- `refactor:` code change that neither fixes a bug nor adds a feature

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
