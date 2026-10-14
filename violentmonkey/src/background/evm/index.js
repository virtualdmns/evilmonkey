/**
 * EvilMonkey session foundation (Phase 1).
 *
 * Imported by src/background/index.js so the service worker registers the
 * session commands, policy gate, and target watchers at startup.
 */
import './orchestrator';

export * from './models';
export * as evmPolicy from './policy';
export * as evmStore from './store';
