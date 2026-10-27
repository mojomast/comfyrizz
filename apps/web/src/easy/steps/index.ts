// Colocated node:test files must stay out of the browser bundle: their
// top-level test() calls throw once node:test is externalized.
export const STEP_MODULES = import.meta.glob(['./*.ts', '!./*.test.ts', '!./index.ts'], { eager: true });
