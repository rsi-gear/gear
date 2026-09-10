/** Harbor runs record the resolved commit; the accepted submission keeps its source URL. */
export function matchesHarnessRef(actual: unknown, submitted: string, adapter: string, commit: string): boolean {
  return actual === submitted || actual === `${adapter}@commit:${commit}`
}
