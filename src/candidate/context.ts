import type { Context } from '@deepseek-ai/cordis'

/**
 * Give one Meta agent its own provider slots before installing the candidate
 * filesystem/search/shell adapters. Agent contexts inherit the control-plane
 * providers, so constructing a second `fs`, `subprocess`, or `shell` service
 * without isolation is rejected by Cordis and, more importantly, would not
 * define an unambiguous execution world for the coding tools.
 */
export function isolateCandidateProviderContext(ctx: Context): Context {
  return ctx.isolate('fs').isolate('subprocess').isolate('shell')
}
