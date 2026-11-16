/**
 * Marina's own profiles for the footer (F-58, OVERVIEW §8.3). The only place these URLs live.
 *
 * Marina to confirm both URLs. The LinkedIn value is a deliberate placeholder (the LinkedIn home page): a personal
 * profile URL is never guessed. It stays until Marina provides it (open question in the phase-1b PR and in the
 * Presentation checklist). Tests assert only that the links exist with the right names, never the targets.
 */
export const PROFILE_LINKS = {
  github: 'https://github.com/Arnoldovna',
  linkedin: 'https://www.linkedin.com/',
} as const;
