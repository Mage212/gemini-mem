# Antigravity Memory Protocol

Memory tools are **available** after MCP setup, but they are **not called automatically**.
The agent must follow this protocol every session.

## Required workflow

1. **Start of conversation / task**
   - Call `memory_get_context` with:
     - `projectPath`: absolute path to the project root (same string every time)
     - `currentPrompt`: the user's current request
   - Use the returned context. Do not ask the user to restate prior work already covered there.

2. **Begin tracking work**
   - Call `memory_get_or_start_session` (or `memory_start_session`) with the same `projectPath`.
   - Keep the returned `sessionId` for later calls.

3. **During significant work**
   - After meaningful changes, call `memory_save_note` with concrete file paths, decisions, and trade-offs.
   - Optionally call `memory_observe` for discrete coding actions (compression runs in the background).

4. **End of task**
   - Call `memory_end_session` with the `sessionId` so Gemini can summarize the session for future retrieval.

## Project path rules

- Always use the **absolute** project root path.
- Trailing slashes are normalized, but prefer one consistent form.
- Wrong or relative paths create a separate empty memory bucket.

## Important limitations

- Memory is a **pull model**: if you skip `memory_get_context`, the session starts with zero long-term memory.
- If you skip `memory_save_note` / `memory_end_session`, there will be little to retrieve next time.
- Gemini API failures are returned as tool errors (no silent mock summaries in production).
