import { GearError } from './errors.js'

export function materialPath(path: string): string {
  if (
    !path ||
    path.length > 4096 ||
    !path.isWellFormed() ||
    path.includes('\\') ||
    path.includes(':') ||
    [...path].some((character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127) ||
    path.split('/').some((part) => ['', '.', '..'].includes(part))
  )
    throw new GearError('invalid-material-path', 'Expected a bounded relative material path')
  return path
}
