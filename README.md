# Antigravity Memory

> Persistent memory layer for Antigravity IDE — your AI never forgets what you built.

**This is a CLI tool, not a library.** Do not add it to your project's `package.json`. Install it globally:

```bash
npm install -g antigravity-memory
antigravity-mem init
```

Fork maintained at: https://github.com/Mage212/gemini-mem

**Dev / agent handoff:** see [docs/HANDOFF.md](docs/HANDOFF.md) and [AGENTS.md](AGENTS.md) for the full Sprint 1–2 work log, remotes, and constraints.

---

Inspired by [Claude-Mem](https://github.com/thedotmack/claude-mem). Claude-Mem uses lifecycle hooks; Antigravity does not expose those yet, so this project uses **MCP tools** that Gemini must call explicitly.

## Important: pull-model memory

MCP tools are **available** after setup, but they are **not automatic**.

Each session the agent must:

1. `memory_get_context` — recall prior work
2. `memory_get_or_start_session`
3. `memory_save_note` — after significant changes
4. `memory_end_session` — when the task is done

See [docs/MEMORY_PROTOCOL.md](docs/MEMORY_PROTOCOL.md). `init` copies the protocol to `~/.antigravity-mem/antigravity-memory-protocol.md`.

## Quick Start

### Option A: Global Install
```bash
npm install -g antigravity-memory
antigravity-mem init
```

### Option B: From Source
```bash
git clone https://github.com/Mage212/gemini-mem.git
cd gemini-mem
npm install && npm run build
npm link
antigravity-mem init
```

The setup wizard will:

1. Ask for your free Gemini API key ([get one here](https://aistudio.google.com/apikey))
2. Create a local SQLite database at `~/.antigravity-mem/memory.db`
3. Write the MCP config to `~/.gemini/antigravity/mcp_config.json`
4. Install the memory protocol checklist for the agent

Then:

```bash
antigravity-mem verify
```

Restart Antigravity IDE.

## How It Works

- **Storage:** local SQLite + FTS5 (`~/.antigravity-mem/memory.db`)
- **Scope:** sessions are partitioned by normalized absolute `projectPath`
- **Compression / summary:** Gemini API (`gemini-2.5-flash-lite` by default)
- **MCP:** stdio server started by Antigravity via MCP config
- **Observation compression:** queued asynchronously (does not block tool calls); `memory_end_session` drains the queue (up to 60s) before summarizing
- **Compression failures:** marked as observation `status=failed` (not silent mock). Inspect with `memory_session_status`. Prefer `memory_save_note` for durable context.

### Existing databases

On startup the DB layer **automatically drops** the unused legacy `observations_fts` virtual table and its triggers if they still exist from older versions. No manual migration step is required. Sessions/notes FTS indexes are unchanged.

## MCP Tools

| Tool | When to Use | What It Does |
|------|-------------|-------------|
| `memory_get_context` | Start of a conversation | Loads relevant past knowledge |
| `memory_get_or_start_session` | Start of a task | Returns or creates active session |
| `memory_start_session` | Start of a task | Creates a session |
| `memory_save_note` | After significant actions | Captures files/decisions |
| `memory_observe` | On code changes | Records + queues Gemini compression |
| `memory_end_session` | Task complete | Summarizes session via Gemini |
| `memory_list_sessions` | Anytime | Browse recent sessions |
| `memory_session_status` | Anytime | Inspect a session |
| `memory_cleanup_sessions` | Maintenance | Prune/close stale sessions |
| `memory_delete_session` | Maintenance | Delete a session |

## CLI Commands

```bash
antigravity-mem init         # Interactive setup wizard
antigravity-mem verify       # Validate setup (config, DB, API key)
antigravity-mem stats        # View memory statistics
antigravity-mem mcp-serve    # Start MCP server (used by IDE)
antigravity-mem context -p . # Preview context block for a project
```

## Environment

| Variable | Purpose | Default |
|----------|---------|---------|
| `GEMINI_API_KEY` | Gemini API access | required (via init) |
| `GEMINI_MODEL` | Model override | `gemini-2.5-flash-lite` |
| `ANTIGRAVITY_MEM_DB` | Database path | `~/.antigravity-mem/memory.db` |
| `MOCK_GEMINI` | Use mock Gemini responses | unset |
| `MOCK_GEMINI_FALLBACK` | Opt-in mock on API failure (`1`) | unset (errors surface to agent) |

## Architecture

```
src/
├── mcp/server.ts              # MCP server — tools over stdio (primary)
├── cli/                       # init, verify, stats, mcp-serve
├── core/database.ts           # SQLite + FTS5
├── core/context-manager.ts    # Builds context (includes active session)
├── core/compression-queue.ts  # Async observation compression
├── core/paths.ts              # projectPath normalization
├── gemini/client.ts           # Gemini compression & summarization
├── gemini/summarizer.ts       # Session summarization (owns endSession)
└── api/server.ts              # Experimental/legacy local HTTP API
```

## Experimental HTTP API

`npm run api` starts a localhost HTTP API + simple UI for debugging.
This path is **experimental/legacy**. Prefer MCP for Antigravity.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
