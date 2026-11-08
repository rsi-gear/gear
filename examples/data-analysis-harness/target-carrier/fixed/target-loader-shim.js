export const name = 'gear-kaggle-target-loader-shim'
// Loader awaits this entry, so all child dependencies must already be ready.
// A child fiber that is merely pending does not delay ctx.plugin().
const url = process.env.DSH_REFINE_TARGET_LOADER_URL
if (typeof url !== 'string' || !url.startsWith('file:')) throw new Error('fixed target loader URL is required')
const loader = await import(url)
export const inject = loader.inject
export async function apply(ctx, config) {
  await ctx.plugin(loader, config)
}
