// Minimal ambient types for refractor (the Prism engine react-syntax-
// highlighter uses under the hood). Only the subset diffHighlight.ts
// consumes is declared; the language modules are plain registration
// functions, so `unknown` is accurate for them.
declare module "refractor/core.js" {
  const refractor: {
    register(language: unknown): void;
    highlight(value: string, language: string): unknown[];
    registered(language: string): boolean;
    listLanguages(): string[];
  };
  export default refractor;
}

declare module "refractor/lang/*.js" {
  const language: unknown;
  export default language;
}
