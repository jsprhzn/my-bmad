const STORY_NUMBER = /^(\d+)[-.](\d+[a-z]?)/i;

/** "1-4-invite-my-accountant" or "1.4" → "1.4"; "1-3c-change-details" → "1.3c"; null when there is no number. */
export function storyNumber(storyId: string): string | null {
  const match = storyId.match(STORY_NUMBER);
  return match ? `${match[1]}.${match[2].toLowerCase()}` : null;
}
