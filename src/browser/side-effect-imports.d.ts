// TypeScript 7 (tsgo) requires declarations for side-effect imports that carry
// no types (TS2882), where tsc 5 accepted them silently. These are the style
// entries the browser bundle pulls in; Vite owns their emission.
declare module "*.css";
declare module "@kontourai/ui/tokens";
