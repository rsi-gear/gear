import { expect, it } from 'vitest';
import { hitchSubprocessEnvironment, hitchSubprocessEnvironmentDigest } from '../../src/evaluator/hitch-environment.js';

it('uses the same execution environment across SSH sessions and shell wrappers while preserving meaningful identity drift', () => {
  const parent = { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy.internal:8080', MODEL: 'authorized-model',
    SSH_CLIENT: '10.0.0.2 43210 22', SSH_CONNECTION: '10.0.0.2 43210 10.0.0.1 22', SSH_TTY: '/dev/pts/0',
    XDG_SESSION_ID: '1559', SHLVL: '0', _: '/usr/bin/previous-command',
    XDG_RUNTIME_DIR: '/run/user/1000', PYTHONDONTWRITEBYTECODE: '0' };
  const reconnect = { ...parent, SSH_CLIENT: '10.0.0.2 54321 22',
    SSH_CONNECTION: '10.0.0.2 54321 10.0.0.1 22', SSH_TTY: '/dev/pts/1',
    XDG_SESSION_ID: '1587', SHLVL: '1', _: '/usr/bin/another-command' };
  expect(hitchSubprocessEnvironment(parent)).toEqual({ PATH: parent.PATH, HTTPS_PROXY: parent.HTTPS_PROXY,
    MODEL: parent.MODEL, XDG_RUNTIME_DIR: parent.XDG_RUNTIME_DIR, PYTHONDONTWRITEBYTECODE: '1' });
  expect(hitchSubprocessEnvironmentDigest(parent)).toBe(hitchSubprocessEnvironmentDigest(reconnect));
  expect(hitchSubprocessEnvironmentDigest({ ...reconnect, HTTPS_PROXY: 'http://other.internal:8080' }))
    .not.toBe(hitchSubprocessEnvironmentDigest(parent));
  expect(hitchSubprocessEnvironmentDigest({ ...reconnect, MODEL: 'other-model' }))
    .not.toBe(hitchSubprocessEnvironmentDigest(parent));
  expect(hitchSubprocessEnvironmentDigest({ ...reconnect, XDG_RUNTIME_DIR: '/run/user/1001' }))
    .not.toBe(hitchSubprocessEnvironmentDigest(parent));
  expect(parent.PYTHONDONTWRITEBYTECODE).toBe('0');
  expect(parent.SSH_CLIENT).toBe('10.0.0.2 43210 22');
  expect(parent.XDG_SESSION_ID).toBe('1559');
  expect(parent.SHLVL).toBe('0');
  expect(parent._).toBe('/usr/bin/previous-command');
});
