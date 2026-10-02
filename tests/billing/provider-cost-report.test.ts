import { describe, expect, it } from 'vitest';
import { readProviderCosts } from '../../scripts/project-budget-report.mjs';

const window = { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z' };
const row = (id: number, cost: string, ref = 'quran-reader:anonymous') => ({ uuid: `00000000-0000-0000-0000-${String(id).padStart(12, '0')}`, client_reference_id: ref, cost_usd: cost, input_audio_duration_ms: 1000 });
const response = (body: unknown) => new Response(JSON.stringify(body));

describe('read-only provider cost report', () => {
  it('attributes only shared-reader requests, sums decimal costs exactly and exposes no keys or identities', async () => {
    const calls: Array<{ url: string; method: string; redirect: string }> = [];
    const result = await readProviderCosts({ ...window, sonioxKey: 'private-speech-key', openrouterKey: 'private-ai-key',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), method: init?.method || 'GET', redirect: init?.redirect || '' });
        return String(url).includes('soniox') ? response({ usage_logs: [row(1, '0.1'), row(2, '0.000000000003'), row(3, '999', 'other-product'), row(4, '999', 'quran-reader')], next_page_cursor: null }) : response({ data: { usage: .0034, usage_monthly: .0001, limit: 5, limit_remaining: 4.9966, label: 'private-ai-key' } });
      }) as typeof fetch });
    expect(result.soniox).toMatchObject({ completeLogScan: true, quranReaderRecords: 2, completedRequestCostUsd: '0.100000000003', reportedAudioSeconds: 2 });
    expect(result.openrouter.keyUsageUsd).toBe(.0034);
    expect(calls.every((c) => c.method === 'GET' && c.redirect === 'error')).toBe(true);
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(['api.soniox.com', 'openrouter.ai']);
    expect(JSON.stringify(result)).not.toMatch(/private-|anonymous|00000000-/);
  });
  it('deduplicates records across pages and withholds a total if the scan is incomplete', async () => {
    const fetchImpl = (async (url) => {
      const next = new URL(String(url)).searchParams.has('cursor');
      return response({ usage_logs: next ? [row(1, '0.1'), row(2, '0.2')] : [row(1, '0.1')], next_page_cursor: next ? null : 'next-page' });
    }) as typeof fetch;
    const complete = await readProviderCosts({ ...window, sonioxKey: 'test', fetchImpl });
    expect(complete.soniox).toMatchObject({ pages: 2, quranReaderRecords: 2, completedRequestCostUsd: '0.3' });
    const partial = await readProviderCosts({ ...window, sonioxKey: 'test', fetchImpl, maxPages: 1 });
    expect(partial.soniox).toMatchObject({ completeLogScan: false, completedRequestCostUsd: null, reportedAudioSeconds: null });
  });
  it('represents denied access as unknown and never echoes the error body', async () => {
    const report = await readProviderCosts({ ...window, sonioxKey: 'secret', fetchImpl: (async () => new Response('secret echoed by upstream', { status: 403 })) as typeof fetch });
    expect(report.soniox).toMatchObject({ status: 403, completeLogScan: false, completedRequestCostUsd: null });
    expect(report.openrouter).toMatchObject({ status: 'not_configured', keyUsageUsd: null });
    expect(JSON.stringify(report)).not.toContain('secret');
  });
  it('refuses invalid costs and repeated cursors instead of manufacturing a zero-cost result', async () => {
    for (const cost of ['-1', 'NaN', '1001', '0.0000000000001']) {
      const report = await readProviderCosts({ ...window, sonioxKey: 'test', fetchImpl: (async () => response({ usage_logs: [row(1, cost)], next_page_cursor: null })) as typeof fetch });
      expect(report.soniox).toMatchObject({ status: 'invalid_response', completedRequestCostUsd: null });
    }
    const repeated = await readProviderCosts({ ...window, sonioxKey: 'test', fetchImpl: (async () => response({ usage_logs: [], next_page_cursor: 'same' })) as typeof fetch });
    expect(repeated.soniox).toMatchObject({ status: 'invalid_response', completeLogScan: false });
  });
  it('validates the report window before contacting a provider', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return response({}); }) as typeof fetch;
    await expect(readProviderCosts({ start: 'invalid', end: window.end, fetchImpl })).rejects.toThrow();
    await expect(readProviderCosts({ start: window.start, end: '2026-12-01T00:00:00Z', fetchImpl })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
