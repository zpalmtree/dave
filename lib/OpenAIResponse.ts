interface OpenAIOutputTextPartLike {
    type?: string;
    text?: unknown;
}

interface OpenAIOutputItemLike {
    type?: string;
    role?: string;
    content?: OpenAIOutputTextPartLike[];
}

interface OpenAIResponseLike {
    output_text?: unknown;
    output?: OpenAIOutputItemLike[];
}

/** Extract only user-facing assistant text, never reasoning summaries. */
export function extractOpenAIResponseText(response: OpenAIResponseLike): string {
    if (typeof response.output_text === 'string') {
        const trimmed = response.output_text.trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }

    const segments: string[] = [];

    for (const item of response.output ?? []) {
        if (item?.type !== 'message' || item.role !== 'assistant') continue;
        if (!Array.isArray(item.content)) continue;

        for (const part of item.content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') {
                const formatted = part.text.trim();
                if (formatted.length > 0) {
                    segments.push(formatted);
                }
            }
        }
    }

    return segments.join('\n\n');
}
