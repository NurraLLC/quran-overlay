export type ReportStatus = number | 'not_configured' | 'unavailable' | 'invalid_response';
export function readProviderCosts(options: {
  start: string; end: string; sonioxKey?: string; openrouterKey?: string; fetchImpl?: typeof fetch; maxPages?: number;
}): Promise<{
  window: { start: string; end: string };
  soniox: { status: ReportStatus; completeLogScan: boolean; pages: number; projectRecordsChecked: number; quranReaderRecords: number; completedRequestCostUsd: string | null; reportedAudioSeconds: number | null };
  openrouter: { status: ReportStatus; keyUsageUsd: number | null; monthUsageUsd: number | null; spendingLimitUsd: number | null; limitRemainingUsd: number | null; attribution: string };
  reconciliation: string;
}>;
