import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
function digest(parts) {
    const hash = createHash('sha256');
    for (const part of parts) {
        const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
        hash.update(String(bytes.byteLength));
        hash.update('\0');
        hash.update(bytes);
        hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
}
async function localTreeDigest(root) {
    const records = [];
    async function visit(path) {
        const info = await lstat(path);
        const name = relative(root, path).split(sep).join('/') || '.';
        if (info.isSymbolicLink())
            throw new Error(`dataset identity refuses symlink: ${name}`);
        if (info.isDirectory()) {
            records.push(`d\0${name}`);
            for (const entry of (await readdir(path)).sort())
                await visit(join(path, entry));
            return;
        }
        if (!info.isFile())
            throw new Error(`dataset identity refuses special file: ${name}`);
        const content = await readFile(path);
        records.push(`f\0${name}\0${info.mode & 0o111 ? 'x' : '-'}\0${digest([content])}\0${content.byteLength}`);
    }
    await visit(root);
    return digest(records);
}
/** Resolve a dataset reference to a stable identity before an evolution starts. */
export async function digestDatasetRef(ref, workspaceRoot = process.cwd()) {
    if (ref.length === 0)
        throw new TypeError('dataset ref must be non-empty');
    try {
        return await localTreeDigest(resolve(workspaceRoot, ref));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        if (isAbsolute(ref))
            throw new Error(`local dataset ref does not exist: ${ref}`, { cause: error });
    }
    // Non-local refs are required to be immutable by their provider. Prefixing
    // the namespace prevents an opaque ref string from colliding with local tree
    // records while still pinning the exact resolved reference in EvolutionSpec.
    return digest(['opaque-immutable-ref', ref]);
}
//# sourceMappingURL=dataset.js.map