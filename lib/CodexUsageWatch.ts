import { createHash } from 'crypto';

interface Window { used: number; minutes: number; resetsAt: number }
export interface UsageSample {
    at: number;
    account: string;
    plan: string;
    windows: Record<string, Window>;
    credits: { count: number; ids: string[] | null } | null;
}
export interface UsageObservation {
    id: string;
    reset_type: 'regular' | 'banked';
    announced_at: string;
    text: string;
    source: { type: 'account_observed' };
}
export interface UsageWatchState {
    version: 1;
    sample: UsageSample;
    candidate?: { before: UsageSample; first: UsageSample; types: UsageObservation['reset_type'][] };
    events: UsageObservation[];
}

// Keep account identity hashed and usage details local. Only observations leave the machine.
export function parseUsageSample(result: any, at = Date.now() / 1000): UsageSample {
    const bucket = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
    if (!result || typeof result.accountId !== 'string' || !result.accountId
        || !bucket || (bucket.limitId && bucket.limitId !== 'codex') || typeof bucket.planType !== 'string') {
        throw new Error('Codex did not return an identifiable account and Codex limits.');
    }
    const windows: Record<string, Window> = {};
    for (const key of ['primary', 'secondary']) {
        const value = bucket[key];
        if (value == null) continue;
        if (!Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100
            || !Number.isFinite(value.windowDurationMins) || value.windowDurationMins <= 0
            || !Number.isFinite(value.resetsAt) || value.resetsAt <= 0) throw new Error('Invalid Codex usage window.');
        windows[key] = { used: value.usedPercent, minutes: value.windowDurationMins, resetsAt: value.resetsAt };
    }
    if (!Object.keys(windows).length) throw new Error('Codex returned no usage windows.');
    let credits: UsageSample['credits'] = null;
    const resetCredits = result.rateLimitResetCredits;
    if (resetCredits != null) {
        if (!Number.isSafeInteger(resetCredits.availableCount) || resetCredits.availableCount < 0) {
            throw new Error('Invalid Codex reset credit count.');
        }
        const rows = resetCredits.credits;
        if (rows != null && (!Array.isArray(rows) || rows.some((row: any) =>
            typeof row?.id !== 'string' || !row.id || row.status !== 'available'))) {
            throw new Error('Invalid Codex reset credit details.');
        }
        const ids: string[] | null = rows == null ? null : [...new Set<string>(rows.map((row: any) => row.id))].sort();
        credits = { count: resetCredits.availableCount,
            ids: ids?.length === resetCredits.availableCount ? ids : null };
    }
    return { at, account: createHash('sha256').update(result.accountId).digest('hex'),
        plan: bucket.planType, windows, credits };
}

function comparable(before: UsageSample, after: UsageSample): boolean {
    return before.account === after.account && before.plan === after.plan
        && after.at - before.at >= 30 && after.at - before.at <= 300;
}

function noRedemption(before: UsageSample, after: UsageSample): boolean {
    if (!before.credits || !after.credits || after.credits.count < before.credits.count) return false;
    // Incomplete credit details cannot exclude a simultaneous redemption and grant.
    return before.credits.count === 0 || Boolean(before.credits.ids && after.credits.ids
        && before.credits.ids.every(id => after.credits!.ids!.includes(id)));
}

function regularDrop(before: UsageSample, first: UsageSample, current = first): boolean {
    return noRedemption(before, first) && noRedemption(first, current)
        && Object.entries(before.windows).some(([key, old]) => {
            const next = first.windows[key];
            const confirmed = current.windows[key];
            return next && confirmed && next.minutes === old.minutes && confirmed.minutes === old.minutes
                // A scheduled rollover (or a polling gap around one) is not a surprise reset.
                && old.resetsAt > current.at + 90 && next.resetsAt > current.at
                // An unused new window can report a moving deadline until usage
                // anchors it. Allow only forward movement bounded by elapsed time
                // (deadlines are whole seconds, sample times can be fractional).
                && confirmed.resetsAt >= next.resetsAt
                && confirmed.resetsAt - next.resetsAt <= Math.ceil(current.at - first.at)
                && old.used >= 5 && next.used <= 5 && old.used - next.used >= 5
                && confirmed.used < old.used;
        });
}

function bankedGain(before: UsageSample, first: UsageSample, current = first): boolean {
    return Boolean(before.credits && first.credits && current.credits
        && first.credits.count > before.credits.count && current.credits.count >= first.credits.count
        && (!first.credits.ids || !current.credits.ids || first.credits.ids.every(id => current.credits!.ids!.includes(id))));
}

export function validateUsageWatchState(state: UsageWatchState): void {
    const validSample = (sample: UsageSample) => sample && Number.isFinite(sample.at)
        && typeof sample.account === 'string' && /^[a-f0-9]{64}$/.test(sample.account)
        && typeof sample.plan === 'string' && sample.windows && Object.keys(sample.windows).length > 0
        && Object.values(sample.windows).every(window => window && Number.isFinite(window.used)
            && window.used >= 0 && window.used <= 100 && Number.isFinite(window.minutes) && window.minutes > 0
            && Number.isFinite(window.resetsAt) && window.resetsAt > 0)
        && (sample.credits === null || (sample.credits && Number.isSafeInteger(sample.credits.count)
            && sample.credits.count >= 0 && (sample.credits.ids === null || (Array.isArray(sample.credits.ids)
                && sample.credits.ids.length === sample.credits.count
                && sample.credits.ids.every(id => typeof id === 'string' && id.length > 0)))));
    if (!state || state.version !== 1 || !validSample(state.sample) || !Array.isArray(state.events)
        || state.events.length > 200 || state.events.some(event => !event || !/^usage-[a-f0-9]{32}$/.test(event.id)
            || !['regular', 'banked'].includes(event.reset_type) || !Number.isFinite(Date.parse(event.announced_at))
            || typeof event.text !== 'string' || event.source?.type !== 'account_observed')
        || (state.candidate && (!validSample(state.candidate.before) || !validSample(state.candidate.first)
            || !Array.isArray(state.candidate.types) || state.candidate.types.some(type => !['regular', 'banked'].includes(type))))) {
        throw new Error('Invalid Codex usage watch state; refusing to replace it.');
    }
}

export function advanceUsageWatch(previous: UsageWatchState | undefined, sample: UsageSample): UsageWatchState {
    if (previous) validateUsageWatchState(previous);
    const state: UsageWatchState = { version: 1, sample,
        events: (previous?.events || []).filter(event => Date.parse(event.announced_at) / 1000 > sample.at - 7 * 86400).slice(-100) };
    if (!previous || !comparable(previous.sample, sample)) return state;
    const candidate = previous.candidate;
    const confirmed = new Set<UsageObservation['reset_type']>();
    if (candidate && comparable(candidate.first, sample) && comparable(candidate.before, candidate.first)) {
        for (const type of candidate.types) {
            const matches = type === 'regular' ? regularDrop(candidate.before, candidate.first, sample)
                : bankedGain(candidate.before, candidate.first, sample);
            if (!matches) continue;
            const id = 'usage-' + createHash('sha256').update(`${sample.account}:${candidate.first.at}:${type}`).digest('hex').slice(0, 32);
            if (!state.events.some(event => event.id === id)) state.events.push({
                id, reset_type: type, announced_at: new Date(candidate.first.at * 1000).toISOString(),
                text: type === 'regular'
                    ? 'An early usage reset was observed on our monitored Codex account and confirmed by a second check. Check your own limits; availability may vary by account.'
                    : 'An increase in available reset credits was observed on our monitored Codex account and confirmed by a second check. This may be an account-specific grant; check your own credits.',
                source: { type: 'account_observed' },
            });
            confirmed.add(type);
        }
    }
    const types: UsageObservation['reset_type'][] = [];
    if (!confirmed.has('regular') && regularDrop(previous.sample, sample)) types.push('regular');
    if (!confirmed.has('banked') && bankedGain(previous.sample, sample)) types.push('banked');
    if (types.length) state.candidate = { before: previous.sample, first: sample, types };
    return state;
}
