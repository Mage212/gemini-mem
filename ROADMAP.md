# Roadmap

## Done (v0.3 / Sprint 1–2)

- MCP-first memory for Antigravity IDE
- Explicit Gemini API errors (no silent mock fallback by default)
- Async compression queue for `memory_observe`
- Normalized `project_path` buckets
- Single `endSession` owner (`SessionSummarizer` → `completed`)
- Default model aligned with init: `gemini-2.5-flash-lite`
- Agent memory protocol docs + init checklist
- Active session included in `memory_get_context`
- Removed unused `observations_fts`
- Session-level `tokens_saved` aggregation
- Vitest unit tests + GitHub Actions CI

## Near-term

- Stronger Antigravity instruction injection when the IDE supports it
- Schema migrations for older databases beyond DROP of dead FTS
- Better FTS query building / ranking

## Later

- Embeddings / semantic search
- Lifecycle hooks if Antigravity exposes them
- Export/import of memory between machines
- First-class web dashboard (HTTP API remains experimental)

## Non-goals (for now)

- Replacing IDE chat history
- Automatic memory without agent tool calls
