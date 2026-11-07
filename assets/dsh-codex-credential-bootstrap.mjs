#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const credentialName = process.env.GEAR_TARGET_CODEX_ENV ?? 'DSH_OPENAI_CODEX_ACCESS_B64'
if (!/^DSH_OPENAI_CODEX_ACCESS(?:_[A-Z0-9]+)*_B64$/u.test(credentialName)) {
  throw new Error('unsupported DSH Codex credential name')
}

const encoded = process.env[credentialName]
if (encoded) {
  // Do not let child tools inherit the short-lived access token after bootstrap.
  process.env[credentialName] = ''

  const home = process.env.DSH_HOME
  if (!home) throw new Error('DSH_HOME is required for the bound Codex credential')

  let envelope
  try {
    envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    throw new Error('invalid bound DSH Codex credential envelope')
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    Object.keys(envelope).sort().join(',') !== 'access,accountId,expires,version' ||
    envelope.version !== 1 ||
    typeof envelope.access !== 'string' ||
    envelope.access.length === 0 ||
    typeof envelope.accountId !== 'string' ||
    envelope.accountId.length === 0 ||
    !Number.isSafeInteger(envelope.expires) ||
    envelope.expires <= Date.now()
  ) {
    throw new Error('invalid bound DSH Codex credential envelope')
  }

  const directory = resolve(home)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const destination = join(directory, '.openai-codex-auth.json')
  const temporary = join(
    directory,
    `.openai-codex-auth.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )
  const document = {
    version: 1,
    credential: {
      type: 'oauth',
      access: envelope.access,
      // The bound task credential deliberately carries no refresh token.
      refresh: 'task-bound-access-only',
      expires: envelope.expires,
      accountId: envelope.accountId,
    },
  }
  writeFileSync(temporary, `${JSON.stringify(document)}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(temporary, destination)
  chmodSync(destination, 0o600)
}
