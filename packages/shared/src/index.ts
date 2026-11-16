// The API contract: Zod schemas and inferred types shared by apps/api (validation, DTOs) and apps/web (forms,
// response parsing). Keep this package free of runtime dependencies other than zod, and never import from apps/*.
export * from './health.js';
