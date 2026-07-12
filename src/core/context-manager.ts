import { MemoryDatabase, Session, Note, NoteWithSession } from './database';

export interface BuildContextOptions {
  projectPath: string;
  currentPrompt?: string;
  recentLimit?: number;
  searchLimit?: number;
}

export class ContextManager {
  constructor(private db: MemoryDatabase) {}

  buildContext({ projectPath, currentPrompt = '', recentLimit = 5, searchLimit = 3 }: BuildContextOptions): string {
    const active = this.db.getActiveSession(projectPath);
    const recent = this.db.getRecentSessions(projectPath, recentLimit);
    const relevant = currentPrompt
      ? this.db.searchSessions(projectPath, currentPrompt, searchLimit)
      : [];

    // Active session first so in-progress work is visible without keyword match.
    const sessions = this.deduplicate([
      ...(active ? [active] : []),
      ...recent,
      ...relevant
    ]);
    const includedSessionIds = new Set(sessions.map((s) => s.id));

    const relatedNotes = currentPrompt
      ? this.db
          .searchNotes(projectPath, currentPrompt, 8)
          .filter((n) => !includedSessionIds.has(n.session_id))
      : [];

    return this.formatContext(sessions, relatedNotes);
  }

  private deduplicate(sessions: Session[]): Session[] {
    const seen = new Set<string>();
    return sessions.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }

  private formatContext(sessions: Session[], relatedNotes: NoteWithSession[] = []): string {
    if (sessions.length === 0 && relatedNotes.length === 0) {
      return 'No prior memory for this project.';
    }

    const parts: string[] = [];
    parts.push('# Antigravity Memory Context');
    parts.push('Use these past sessions to ground your response.');

    if (sessions.length > 0) {
      sessions.forEach((session) => {
        const date = new Date(session.created_at).toISOString().split('T')[0];
        const label = session.status === 'active' ? 'active / in progress' : session.status;
        parts.push(`\n## Session ${date} [${label}]`);
        if (session.user_prompt) parts.push(`Task: ${session.user_prompt}`);
        if (session.summary) {
          parts.push(session.summary.trim());
        } else if (session.status === 'active') {
          parts.push('(No summary yet — session still active. See Key Actions below.)');
        }

        const notes = this.db.getNotesForSession(session.id);
        if (notes.length > 0) {
          parts.push('\n### Key Actions');
          notes.forEach((note: Note) => {
            if (note.ai_response) parts.push(`- ${note.ai_response}`);
            if (note.annotation) parts.push(`  Note: ${note.annotation}`);
          });
        }

        const statusParts: string[] = [];
        if (session.total_observations) statusParts.push(`${session.total_observations} changes captured`);
        if (session.tokens_saved) statusParts.push(`~${session.tokens_saved} tokens saved`);
        if (statusParts.length > 0) parts.push(`\n${statusParts.join(' · ')}`);
      });
    }

    if (relatedNotes.length > 0) {
      parts.push('\n## Related Past Notes');
      parts.push('These notes from older sessions matched your current query:');
      const seenSessions = new Set<string>();
      relatedNotes.forEach((note) => {
        const date = new Date(note.session_created_at).toISOString().split('T')[0];
        const sessionLabel = note.session_user_prompt
          ? `"${note.session_user_prompt}"`
          : note.session_id;
        if (!seenSessions.has(note.session_id)) {
          parts.push(`\n### From session ${date} — ${sessionLabel}`);
          seenSessions.add(note.session_id);
        }
        if (note.ai_response) parts.push(`- ${note.ai_response}`);
        if (note.annotation) parts.push(`  Note: ${note.annotation}`);
      });
    }

    parts.push('\n--\nRespond using this context; do not ask the user to restate it.');
    return parts.join('\n');
  }
}
