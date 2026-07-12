# Memory Protocol for Agents

Copy this into your Antigravity / Gemini agent instructions if supported.

At the start of every coding conversation for a project:

1. Call `memory_get_context` with the absolute project root and the user's request.
2. Call `memory_get_or_start_session` for the same project path.
3. After significant changes, call `memory_save_note` with files changed and decisions.
4. When the task is done, call `memory_end_session`.

Do not ask the user to restate prior work that already appears in memory context.
Tools are not automatic — you must call them.
