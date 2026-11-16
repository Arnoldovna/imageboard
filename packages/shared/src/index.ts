// The API contract: Zod schemas and inferred types shared by apps/api (validation, DTOs) and apps/web (forms,
// response parsing). Keep this package free of runtime dependencies other than zod, and never import from apps/*.
// Test vectors live in the separate entry point `@app/shared/testing`, so they never reach the web bundle.
export * from './comments.js';
export * from './health.js';
export * from './ids.js';
export * from './images.js';
export * from './limits.js';
export * from './messages.js';
export * from './pagination.js';
export * from './problem.js';
export * from './session.js';
export * from './text.js';
