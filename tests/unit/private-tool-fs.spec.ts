import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import * as ToolFs from '../../assets/gear-tool-fs.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

it('reads local images and edits text through each isolated candidate filesystem', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gear-private-tool-fs-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: directory })
    ctx.llm.registerAdapter(['fixture'], new class extends LlmAdapter {
      override async resolveModel(provider: string, model: string) {
        return { provider, id: model, name: model, inputModalities: ['text', 'image'] as const }
      }
      override stream(): never { throw new Error('this test makes no model request') }
    }())
    const saved: Buffer[] = []
    ctx.provide('attachments', {
      imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 1_000, maxMessageImageBytes: 1_000 },
      async saveImage(input: { data: Uint8Array }) {
        saved.push(Buffer.from(input.data))
        return { attachmentId: AttachmentId(`fixture-${saved.length}`), mediaType: 'image/png', bytes: input.data.byteLength, width: 1, height: 1 }
      },
    } as never)
    for (const name of ['first', 'second']) {
      const cwd = join(directory, name)
      await mkdir(cwd)
      await writeFile(join(cwd, 'pixel.png'), png)
      await writeFile(join(cwd, 'note.txt'), `${name}\nbefore\n`)
      const agent = {
        options: { provider: 'fixture', model: 'vision' },
        session: { header: { cwd }, requestHeader: () => undefined },
      }
      const scope = createScope(ctx, agent)
      try {
        const candidateCtx = scope.ctx.isolate('fs')
        await candidateCtx.plugin(LocalFileSystem, { cwd })
        await candidateCtx.plugin(ToolFs)
        const call = (tool: string, args: unknown) => ctx.tools.execute({
          name: tool, arguments: args, agent: agent as never,
          callId: CallId(`${name}-${tool}`), signal: new AbortController().signal,
        })
        const image = await call('read_image', { file_path: 'pixel.png' })
        expect(image.isError, JSON.stringify(image)).toBe(false)
        expect(image.content.some(block => block.type === 'image')).toBe(true)
        expect(saved.at(-1)).toEqual(png)
        const edit = await call('edit', { file_path: 'note.txt', old_string: 'before', new_string: 'after' })
        expect(edit.isError, JSON.stringify(edit)).toBe(false)
        expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe(`${name}\nafter\n`)
      } finally {
        await scope.dispose()
      }
    }
    expect(saved).toHaveLength(2)
    await expect(readFile(join(directory, 'pixel.png'))).rejects.toThrow()
  } finally {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
