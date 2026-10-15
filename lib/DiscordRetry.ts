const INITIAL_LOGIN_RETRY_DELAY_MS = 5_000;
const MAX_LOGIN_RETRY_DELAY_MS = 60_000;

export function isDisallowedIntentsError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: string | number }).code;
    return code === 4014 || code === 'DisallowedIntents'
        || error.message === 'Used disallowed intents';
}

export function getDiscordLoginRetryDelay(attempt: number): number {
    const safeAttempt = Math.max(0, Math.floor(attempt));
    return Math.min(
        INITIAL_LOGIN_RETRY_DELAY_MS * (2 ** safeAttempt),
        MAX_LOGIN_RETRY_DELAY_MS,
    );
}
