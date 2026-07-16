# Handoff: Antigravity Memory (gemini-mem fork) — Sprint 1–2 + residual fixes

> **Для агента:** этот файл — источник правды о проделанной доработке. Читай его целиком перед изменениями. Не путай с upstream `keyut-shah/gemini-mem`.

**Дата handoff:** 2026-07-12  
**Форк:** https://github.com/Mage212/gemini-mem  
**Локальный путь (на машине автора):** `/Users/vadimmitroshkin/coding_projects/mcp/gemini-mem`  
**Рабочая ветка:** `main` (и `sprint-1/stable-mcp` синхронизирована с ней)  
**Последние коммиты (на момент handoff):**
- `484ffa2` — bump: version 0.3.1
- `88bcf4e` — fix: replace third-party uuid package with native crypto.randomUUID to restore Node 18 compatibility
- `1701995` — Add exhaustive HANDOFF doc for future agent sessions
- `d5fa507` — Fix residual gaps: drain queue before summarize, document FTS drop
- `6af9b4d` — Stabilize Antigravity MCP memory (Sprint 1–2)

**Upstream (не пушить туда без запроса):** `https://github.com/keyut-shah/gemini-mem.git` (remote `upstream`)  
**Origin (форк):** `https://github.com/Mage212/gemini-mem.git` (remote `origin`)

**Статус merge:** изменения **влиты в `main` форка**. Созданы и отправлены теги `v0.3.0` (Sprint 1–2 milestone) и `v0.3.1` (исправление Node 18).

---

## 1. Зачем это делалось

Оригинальный [keyut-shah/gemini-mem](https://github.com/keyut-shah/gemini-mem) — MCP-память для **Antigravity IDE** (аналог Claude-Mem, но через MCP tools + Gemini API для сжатия/суммаризации).

Проект полезный, но сырой (мало звёзд, хакатонный MVP). Провели code review и реализовали план **двух спринтов** на форке пользователя **Mage212**, целевой IDE — **Antigravity** (не Cursor-first).

### Ключевое понимание продукта (не ломать)

1. Память — **pull-модель**: MCP tools **не вызываются сами**; агент должен вызывать их по протоколу.
2. Одна глобальная SQLite БД (`~/.antigravity-mem/memory.db`), scope — поле **`project_path`** (абсолютный путь).
3. Gemini API используется для **compression observations** и **session summary**, не как «память модели».
4. Primary path = **MCP stdio**. HTTP API / web UI — **experimental/legacy**.

---

## 2. Что было не так (находки исходного review)

### Подтверждённые проблемы (исправлены в спринтах)

| Проблема | Суть |
|----------|------|
| Silent mock-fallback | При ошибке Gemini писался `MOCK SUMMARY`, агент думал что всё ок |
| Sync compression в MCP | `memory_observe` ждал Gemini; на 429 — sleep 60s **в tool handler** |
| Нет normalize `project_path` | `/foo/bar` и `/foo/bar/` — разные bucket’ы памяти |
| Double `endSession` | Summarizer ставил `summarized`, MCP снова `completed` |
| Default model `gemini-pro` | Init писал `gemini-2.5-flash-lite` — расхождение |
| Нет onboarding протокола | README намекал на «auto», tools не auto |
| Active session не в context | `getRecentSessions` исключал `active` |
| Dead `observations_fts` | INSERT при NULL compressed; FTS никем не читался |
| `sessions.tokens_saved` = 0 | Обновлялись только observations |
| Нет тестов / CI | `"test": "echo 'tests pending'"` |
| Устаревший ROADMAP | Говорил «No MCP» |

### Ложные / завышенные претензии (не чинить снова как «баги»)

- «FTS observations ломает retrieval» — retrieval шёл через sessions/notes FTS; observations_fts был dead code.
- «`db.db` в API — runtime crash» — TS `private` не скрывает поле в runtime.
- npm audit transitive — низкий риск для local MCP.

---

## 3. План спринтов (что решили делать)

Документ плана (Cursor): `~/.cursor/plans/two_sprint_fixes_0839f2e7.plan.md`  
**Не редактировать plan file** без запроса пользователя.

### Вне scope (не делали и не делать без запроса)

- Embeddings / semantic search
- Cursor hooks / lifecycle hooks
- Export/import памяти
- Полноценный web dashboard
- PR в upstream keyut-shah (пока только форк)

### Scope

- Форк Mage212, MCP для Antigravity
- Sprint 1 = стабильный MVP (P0 + ключевой P1)
- Sprint 2 = тесты, active context, FTS cleanup, CI, docs
- Затем residual fixes по повторному review

---

## 4. Что реализовано — Sprint 1

### 4.1 Явные ошибки вместо silent mock (`src/gemini/client.ts`)

- Default model: **`gemini-2.5-flash-lite`**
- Mock fallback **только** если `MOCK_GEMINI_FALLBACK=1` (opt-in)
- `MOCK_GEMINI=1` — полный mock для тестов
- Иначе throw с понятным `wrapError` (quota / auth / generic)
- `memory_end_session` возвращает `isError: true` при ошибке summarize

### 4.2 Async compression queue

- Новый модуль: [`src/core/compression-queue.ts`](../src/core/compression-queue.ts)
- `memory_observe` сохраняет observation сразу, compression — в фоне
- Retry/sleep 60s на 429 остаётся **внутри** GeminiClient (воркер), не в tool handler
- При ошибке compression: `markObservationFailed` → `status=failed`

### 4.3 Path normalization

- [`src/core/paths.ts`](../src/core/paths.ts) — `normalizeProjectPath()`
- `path.resolve` + strip trailing slash
- Применяется во всех project-scoped методах `MemoryDatabase`

### 4.4 Dedup endSession

- **Единственный owner:** `SessionSummarizer.summarize()` → `endSession(..., 'completed')`
- MCP **не** вызывает `endSession` повторно
- Default статус `endSession` = `completed`

### 4.5 Antigravity onboarding

- `init` копирует protocol в `~/.antigravity-mem/antigravity-memory-protocol.md`
- Явный checklist: get_context → get_or_start → save_note → end_session
- Файлы: [`templates/antigravity-memory-protocol.md`](../templates/antigravity-memory-protocol.md), [`docs/MEMORY_PROTOCOL.md`](MEMORY_PROTOCOL.md)
- `execSync` заменён на `execFileSync` (безопаснее)

### 4.6 Версия

- package / MCP / CLI: **0.3.1** (версия `0.3.0` была обновлена до `0.3.1` из-за исправления совместимости Node 18)
- repository URL in package.json → Mage212 fork

---

## 5. Что реализовано — Sprint 2

### 5.1 Vitest

- `vitest` + [`vitest.config.ts`](../vitest.config.ts)
- Тесты: [`tests/paths.test.ts`](../tests/paths.test.ts), [`tests/core.test.ts`](../tests/core.test.ts)
- Покрытие: path normalize, path scoping, tokens_saved, active context, empty summarizer, queue enqueue, **drain**
- `npm test` = `vitest run`

### 5.2 Active session в context

- [`src/core/context-manager.ts`](../src/core/context-manager.ts) включает `getActiveSession` первым
- Notes активной сессии видны без keyword match

### 5.3 Удалён dead `observations_fts`

- Нет CREATE в schema
- `dropDeadObservationsFts()` на старте БД (для старых installs)

### 5.4 `sessions.tokens_saved`

- В `markObservationCompressed` инкремент `sessions.tokens_saved`

### 5.5 CI

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — Node 18/20, install → build → test
- Триггеры: push `main`, `sprint-1/**`, `sprint-2/**`, PR на `main`

### 5.6 Docs

- README: Antigravity-first, честный pull-model, HTTP = experimental
- ROADMAP переписан под MCP-реальность

---

## 6. Residual fixes (после повторного review) — коммит `d5fa507`

Подтверждённые недоработки и что сделали:

| Недоработка | Решение |
|-------------|---------|
| Race: `end_session` до конца queue | `compressionQueue.drain(60_000)` перед summarize (MCP + HTTP `/summarize`) |
| Docs про DROP FTS | Секция **Existing databases** в README |
| Failed compression «невидимы» агенту | Описания tools + warning в end_session + `memory_session_status` hint + protocol docs |

**Не трогали намеренно:**
- Sleep 60s в GeminiClient при 429 (по плану — в воркере)
- Merge в main / теги (нужно явное ОК пользователя)
- Ручной smoke в живой Antigravity IDE

---

## 7. Текущая архитектура (после доработок)

```
src/
├── mcp/server.ts              # Primary: MCP tools, queue, drain before end
├── cli/index.ts               # CLI 0.3.0
├── cli/init.ts                # Wizard + protocol copy
├── core/database.ts           # SQLite + FTS5 (sessions/notes), path normalize, DROP dead FTS
├── core/context-manager.ts    # Context incl. active session
├── core/compression-queue.ts  # Async compress + drain()
├── core/paths.ts              # normalizeProjectPath
├── gemini/client.ts           # Gemini; default flash-lite; no silent mock
├── gemini/summarizer.ts       # Sole endSession owner → completed
└── api/server.ts              # Experimental HTTP (uses same queue/drain)
```

### MCP tools (актуальный список)

| Tool | Поведение |
|------|-----------|
| `memory_get_context` | Context: active + recent + FTS |
| `memory_get_or_start_session` | Active или новая; stale >24h закрывается |
| `memory_start_session` | Новая сессия |
| `memory_save_note` | **Primary** durable capture |
| `memory_observe` | Record + async compress queue |
| `memory_end_session` | **drain queue** → summarize → completed |
| `memory_session_status` | Counts incl. `failed` compressions |
| `memory_list_sessions` | Recent non-active |
| `memory_cleanup_sessions` | Prune / close stale |
| `memory_delete_session` | Hard delete |

### Env

| Variable | Meaning |
|----------|---------|
| `GEMINI_API_KEY` | Required (unless `MOCK_GEMINI=1`) |
| `GEMINI_MODEL` | Default `gemini-2.5-flash-lite` |
| `ANTIGRAVITY_MEM_DB` | Default `~/.antigravity-mem/memory.db` |
| `MOCK_GEMINI` | Full mock (tests) |
| `MOCK_GEMINI_FALLBACK` | Opt-in mock on API failure (`1` only) |

---

## 8. Протокол агента (обязательно помнить)

```
1. memory_get_context(projectPath, currentPrompt)
2. memory_get_or_start_session(projectPath)
3. memory_save_note(...) после значимых изменений
4. memory_observe(...) опционально (async compress)
5. memory_end_session(sessionId) — drain + summary
```

`projectPath` = **абсолютный** корень проекта, стабильная строка.

---

## 9. Как проверить локально

```bash
cd /Users/vadimmitroshkin/coding_projects/mcp/gemini-mem
git checkout sprint-1/stable-mcp
git pull origin sprint-1/stable-mcp
npm install
npm run build
MOCK_GEMINI=1 npm test
```

Ожидание: **9 tests passed**, tsc без ошибок.

Ручной smoke (когда пользователь попросит / даст API key):

```bash
npm link   # или npm run build && node dist/cli/...
antigravity-mem init      # выбрать Antigravity
antigravity-mem verify
# restart Antigravity IDE
# agent: get_context → notes → end_session
```

---

## 10. Git remotes и ветки

```bash
git remote -v
# origin    https://github.com/Mage212/gemini-mem.git
# upstream  https://github.com/keyut-shah/gemini-mem.git

git branch -vv
# main                484ffa2 [origin/main]  # актуальная ветка релиза
# sprint-1/stable-mcp 484ffa2 [origin/sprint-1/stable-mcp]  # синхронизирована с main
```

### Что ещё не сделано (по плану релизов)

1. Merge `sprint-1/stable-mcp` → `main` (форка) — **Выполнено**
2. Tag `v0.3.0` (Sprint 1 milestone) — **Выполнено**
3. Tag `v0.3.1` (Sprint 2 + residuals + Node 18 fix) — **Выполнено**
4. Опционально: PR в upstream (только если пользователь попросит)

---

## 11. Связь с workspace `memory-tools`

Cursor workspace часто открыт как `coding_projects/mcp/memory-tools` — это **другой** каталог (vendors: fastcontext, ratel, и т.д.).  
Код доработок живёт в **sibling** `../gemini-mem`.

Если агент запущен **внутри** `gemini-mem` — работать здесь.  
Если запущен в `memory-tools` — править `../gemini-mem` или попросить открыть папку форка.

---

## 12. Известные ограничения (не баги спринта)

1. **Pull-модель** — без rules/protocol агент может не вызывать tools.
2. **Async observe** — ошибка compression не приходит как `isError` в том же tool call; смотреть `memory_session_status` / warning после end_session.
3. **Drain timeout 60s** — при долгом 429 retry queue может не успеть; end_session предупредит.
4. **Keyword FTS only** — нет embeddings.
5. **HTTP API** — legacy, не развивать без запроса.

---

## 13. Рекомендации агенту при следующем запуске

1. Прочитать **этот файл** и `ROADMAP.md`.
2. `git status` / `git log -5` — убедиться что на `sprint-1/stable-mcp` или уже merged main.
3. `MOCK_GEMINI=1 npm test` перед крупными правками.
4. Не возвращать silent mock-fallback по умолчанию.
5. Не добавлять второй `endSession` в MCP.
6. Не коммитить/мержить/тегировать без явного запроса пользователя (кроме случаев, когда пользователь явно просит).
7. Не пушить в `upstream` без запроса.

---

## 14. Краткая хронология разговора / решений

1. Клонировали upstream в `mcp/gemini-mem`, изучили архитектуру.
2. Объяснили pull-модель, project_path scoping, роль Gemini API.
3. Code review → оценка 2 спринта.
4. Пользователь: форк + MCP для Antigravity.
5. Создали форк Mage212, ветку `sprint-1/stable-mcp`, реализовали Sprint 1+2.
6. Повторный review → residual fixes (`drain`, docs FTS, fail visibility).
7. Этот handoff-документ для продолжения работы в папке проекта.

---

## 15. Быстрые ссылки на ключевые файлы

| Файл | Зачем |
|------|-------|
| `src/mcp/server.ts` | MCP tools, drain, queue |
| `src/core/compression-queue.ts` | enqueue / drain / failed |
| `src/core/database.ts` | schema, normalize, tokens_saved, DROP FTS |
| `src/core/paths.ts` | path normalize |
| `src/core/context-manager.ts` | active + recent + FTS context |
| `src/gemini/client.ts` | API, model, no silent mock |
| `src/gemini/summarizer.ts` | sole endSession |
| `src/cli/init.ts` | wizard + protocol |
| `docs/MEMORY_PROTOCOL.md` | agent protocol |
| `docs/HANDOFF.md` | **этот документ** |
| `tests/core.test.ts` | regression suite |
| `.github/workflows/ci.yml` | CI |

---

*Конец handoff. При существенных новых изменениях — дописывай секцию в конец этого файла или обновляй даты/коммиты в шапке.*
