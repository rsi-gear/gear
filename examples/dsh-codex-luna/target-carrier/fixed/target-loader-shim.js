export const name = 'gear-target-harness-loader-shim'

export async function apply(ctx, config) {
  const url = process.env.DSH_REFINE_TARGET_LOADER_URL
  if (typeof url !== 'string' || !url.startsWith('file:')) {
    throw new Error('target loader URL is missing or is not a file URL')
  }
  const plugin = await import(url)
  await ctx.plugin(plugin, config)
}
