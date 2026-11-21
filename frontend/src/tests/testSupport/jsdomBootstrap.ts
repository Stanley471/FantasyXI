import { JSDOM } from "jsdom";

/**
 * Side-effect-only module that must be the FIRST import in any test file
 * that renders React components into jsdom and needs native `input`/`change`
 * events to reach controlled inputs.
 *
 * react-dom feature-detects `isInputEventSupported` once, at module load,
 * by checking `typeof window !== "undefined"`. Since ES module imports are
 * evaluated in dependency order (this module's body runs to completion
 * before the importing file's next import starts), importing this file
 * before `react-dom/client` guarantees that detection sees a real DOM
 * instead of permanently caching the "no DOM" fallback for the process.
 */
const bootDom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as Record<string, unknown>).window = bootDom.window;
(globalThis as Record<string, unknown>).document = bootDom.window.document;
(globalThis as Record<string, unknown>).navigator = bootDom.window.navigator;
