/** Pure argument adapter for a future `gear history inspect` command. */
import { inspectHistoricalRoundReport, HistoricalReportError } from './report.js';

/** `argv` starts after `history`, for example `['inspect', stateRoot, '--round', roundId]`. */
export async function runHistoryInspect(argv: string[], emit: (json: string) => void): Promise<0> {
  if (argv[0] !== 'inspect' || typeof argv[1] !== 'string' || argv[1].startsWith('--'))
    throw new HistoricalReportError('source-path-invalid', 'usage: history inspect <stateRoot> --round <id> [--sha256 <hex>]');
  let roundId: string | undefined;
  let expectedByteSha256: string | undefined;
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--'))
      throw new HistoricalReportError('source-path-invalid', `missing value for ${String(flag)}`);
    if (flag === '--round' && roundId === undefined) roundId = value;
    else if (flag === '--sha256' && expectedByteSha256 === undefined) expectedByteSha256 = value;
    else throw new HistoricalReportError('source-path-invalid', `unknown or repeated option: ${String(flag)}`);
  }
  if (roundId === undefined)
    throw new HistoricalReportError('source-path-invalid', '--round is required');
  const report = await inspectHistoricalRoundReport({ sourceRoot: argv[1], roundId,
    ...(expectedByteSha256 === undefined ? {} : { expectedByteSha256 }) });
  emit(JSON.stringify(report));
  return 0;
}
