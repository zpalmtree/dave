interface ProviderApiErrorOptions {
    provider: string;
    status?: number;
    statusText?: string;
    body?: string;
    error?: unknown;
    fallback?: string;
    maxLength?: number;
}

const MESSAGE_KEYS = [
    'message',
    'error_description',
    'detail',
    'details',
    'reason',
    'title',
    'description',
];

const NESTED_KEYS = [
    'error',
    'response',
    'data',
    'body',
    'cause',
];

const META_KEYS = [
    'code',
    'type',
    'param',
    'status',
    'statusText',
];

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function parseJsonText(value: string): unknown | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    try {
        return JSON.parse(trimmed);
    } catch {
        return undefined;
    }
}

function parseEmbeddedJson(value: string): unknown | undefined {
    const firstBrace = value.indexOf('{');
    const lastBrace = value.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        return parseJsonText(value.slice(firstBrace, lastBrace + 1));
    }

    const firstBracket = value.indexOf('[');
    const lastBracket = value.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
        return parseJsonText(value.slice(firstBracket, lastBracket + 1));
    }

    return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushUnique(parts: string[], value: unknown): void {
    if (value === undefined || value === null) return;

    const normalized = normalizeWhitespace(String(value));
    if (!normalized || parts.includes(normalized)) return;

    parts.push(normalized);
}

function collectErrorParts(value: unknown, parts: string[], seen = new Set<unknown>(), depth = 0): void {
    if (value === undefined || value === null || depth > 5 || seen.has(value)) {
        return;
    }

    if (typeof value === 'string') {
        const parsed = parseJsonText(value) ?? parseEmbeddedJson(value);
        if (parsed !== undefined && parsed !== value) {
            collectErrorParts(parsed, parts, seen, depth + 1);
            return;
        }

        pushUnique(parts, value);
        return;
    }

    if (typeof value !== 'object') {
        pushUnique(parts, value);
        return;
    }

    seen.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            collectErrorParts(item, parts, seen, depth + 1);
        }
        return;
    }

    if (!isRecord(value)) return;

    const initialPartCount = parts.length;

    for (const key of MESSAGE_KEYS) {
        collectErrorParts(value[key], parts, seen, depth + 1);
    }

    for (const key of NESTED_KEYS) {
        collectErrorParts(value[key], parts, seen, depth + 1);
    }

    if (parts.length === initialPartCount) {
        for (const key of META_KEYS) {
            const item = value[key];
            if (typeof item === 'string' || typeof item === 'number') {
                pushUnique(parts, `${key}: ${item}`);
            }
        }
    }

    if (parts.length === initialPartCount) {
        try {
            pushUnique(parts, JSON.stringify(value));
        } catch {
            // Ignore objects that cannot be serialized.
        }
    }
}

function truncateMessage(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 1)}…`;
}

export function formatProviderApiError(options: ProviderApiErrorOptions): string {
    const parts: string[] = [];

    if (options.body) {
        collectErrorParts(options.body, parts);
    }

    if (options.error) {
        collectErrorParts(options.error, parts);
    }

    const status = options.status ?? (isRecord(options.error) && typeof options.error.status === 'number'
        ? options.error.status
        : undefined);
    const verb = status && status >= 400 && status < 500
        ? 'rejected the request'
        : 'failed';
    const fallback = options.fallback || `${status ? `${status}: ` : ''}${options.provider} API ${verb}.`;
    const message = parts.length > 0
        ? `${status ? `${status}: ` : ''}${parts.join('; ')}`
        : fallback;

    return truncateMessage(message, options.maxLength ?? 1900);
}
