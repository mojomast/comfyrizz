/** Ambient types so the web typecheck can follow the planner source import. */
declare module 'node:crypto' {
  interface Hash {
    update(data: string): Hash;
    digest(encoding?: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}
