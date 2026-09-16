import { createHash } from 'node:crypto';
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
export function digestJson(value) {
    return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}
//# sourceMappingURL=digest.js.map