export function buildCompressionPrompt(fn: string, args: string = '', res: string = ''): string {
  return [
    'Summarize this coding action concisely but thoroughly (150-250 tokens):',
    `Function: ${fn}`,
    `Args: ${args?.slice(0, 2000)}`,
    `Result: ${res?.slice(0, 2000)}`,
    '',
    'Your summary MUST include:',
    '- What specific files/components were affected',
    '- What changed (additions, modifications, deletions, refactors)',
    '- Why it matters (bug fix, new feature, config change, dependency update)',
    '- Any key decisions or trade-offs visible in the change',
    '',
    'Write in dense, informative prose. Skip boilerplate and filler.'
  ].join('\n');
}

export function buildSummaryPrompt(userPrompt: string, observations: string[]): string {
  const lines = observations.map((obs, i) => `${i + 1}. ${obs}`).join('\n');
  return [
    'You are summarizing a coding session for a developer memory system.',
    'The summary will be stored and used to restore context in future sessions.',
    '',
    `User goal: ${userPrompt}`,
    '',
    'Actions taken during the session:',
    lines,
    '',
    'Write a detailed summary (6-10 sentences, ~200-400 words) covering:',
    '1. **What was accomplished**: The main outcomes and deliverables.',
    '2. **Key files and components**: Specific files modified/created and their roles.',
    '3. **Technical decisions**: Architecture choices, patterns used, trade-offs made.',
    '4. **Current state**: What works now, what was left incomplete or needs follow-up.',
    '5. **Learnings and gotchas**: Bugs encountered, workarounds applied, insights gained.',
    '',
    'Write in clear, dense prose (not bullets). This summary must be useful enough',
    'that a developer reading it cold can understand what happened and continue the work.'
  ].join('\n');
}
