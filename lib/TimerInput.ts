import moment from 'moment';

export type TimerInput = {
    time: moment.Moment;
    description?: string;
} | { error: string };

/** Parse absolute dates in UTC unless an explicit numeric offset is supplied. */
export function parseTimerInput(input: string, now = moment.utc()): TimerInput {
    let time: moment.Moment;
    let description: string | undefined;

    if (/^\d{4}-/.test(input)) {
        const parts = input.split(/\s+/);
        let date = parts.shift()!;
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{1,2}:/.test(parts[0] ?? '')) {
            date += `T${parts.shift()}`;
        }
        description = parts.join(' ') || undefined;

        // Validate both the calendar date and clock; do not accept JS date rollover.
        const match = /^(\d{4}-\d{2}-\d{2})(?:T((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/.exec(date);
        if (!match) {
            return { error: 'Invalid date. Use YYYY-MM-DD, optionally followed by HH:mm or HH:mm:ss and Z or an offset such as -05:00.' };
        }
        time = moment.utc(`${match[1]}T${match[2] ?? '00:00'}${match[3] ?? 'Z'}`, moment.ISO_8601, true);
        if (!time.isValid()) {
            return { error: 'Invalid calendar date.' };
        }
        if (time.valueOf() <= now.valueOf()) {
            return { error: 'The reminder date must be in the future.' };
        }
    } else {
        const number = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
        const match = new RegExp(`^(?:${number}y)?(?:${number}(?:M|mm))?(?:${number}w)?(?:${number}d)?(?:${number}h)?(?:${number}m)?(?:${number}s)?(?: (.+))?$`).exec(input);
        if (!match) {
            return { error: 'Failed to parse input.' };
        }
        const [, years = '0', months = '0', weeks = '0', days = '0', hours = '0', minutes = '0', seconds = '0', message] = match;
        description = message;
        const monthSeconds = now.clone().add(Number(months), 'months').diff(now, 'seconds');
        const totalSeconds = Number(seconds)
            + Number(minutes) * 60
            + Number(hours) * 3600
            + Number(days) * 86400
            + Number(weeks) * 7 * 86400
            + monthSeconds
            + Number(years) * 365 * 86400;
        if (!Number.isFinite(totalSeconds) || totalSeconds > 365 * 86400 * 100) {
            return { error: 'Timers longer than 100 years are not supported.' };
        }
        if (totalSeconds <= 0) {
            return { error: 'Invalid or no time duration given.' };
        }
        time = now.clone().utc().add(totalSeconds, 'seconds');
    }

    if (time.diff(now, 'seconds', true) > 365 * 86400 * 100) {
        return { error: 'Timers longer than 100 years are not supported.' };
    }
    return { time, description };
}
