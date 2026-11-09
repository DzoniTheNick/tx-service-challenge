/** Vite raw text imports (e.g. bundled SKILL.md fallback). */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
