// Live demo (PLAN Etappe 3b): loaded only when `import.meta.env.MODE === 'demo'` (main.ts, App.vue), so the
// production bundle contains none of it and no MSW (`pnpm check:bundle`).
export { default as DemoBanner } from './components/DemoBanner.vue';
export { startDemo } from './start-demo';
