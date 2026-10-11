import { digestJson } from '../state/digest.js';

/** The exact environment passed to Hitch, excluding controller session and shell metadata. */
export function hitchSubprocessEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...parent, PYTHONDONTWRITEBYTECODE: '1' };
  delete environment.SSH_CLIENT;
  delete environment.SSH_CONNECTION;
  delete environment.SSH_TTY;
  delete environment.XDG_SESSION_ID;
  delete environment.SHLVL;
  delete environment._;
  return environment;
}

/** Persist only a digest, retaining model, proxy and other execution-affecting settings. */
export function hitchSubprocessEnvironmentDigest(parent: NodeJS.ProcessEnv = process.env): string {
  return digestJson(hitchSubprocessEnvironment(parent));
}
