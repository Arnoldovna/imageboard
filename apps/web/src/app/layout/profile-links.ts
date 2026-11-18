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

/**
 * The maw-studio imprint (Impressum) that covers this project (PLAN Etappe 3b, ADR 0019 §5), linked from the footer.
 * Marina to confirm: no imprint URL existed in the repository, so this is the conventional path on her portfolio
 * domain (maw-studio.de, maw-design-system). Change it only here.
 */
export const MAW_STUDIO_IMPRINT_URL = 'https://maw-studio.de/impressum/';
