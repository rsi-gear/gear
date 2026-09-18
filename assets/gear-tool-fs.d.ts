// Public surface of the pinned ToolFs bundle built by scripts/build-private-tool-fs.mjs.
import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

export declare const name: 'tool-fs'
export declare const inject: string[]
export interface Config {
  readLimit?: number
  readMaxLineLength?: number
  readMaxBytes?: number
  readStreamMinSize?: number
}
export declare const Config: z<Config>
export declare function apply(ctx: Context, config: Config): void
