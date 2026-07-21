interface XAIResponseMessage {
    role: string;
    type?: string;
    content: unknown;
}

export function isGrokImageModerationRejection(status: number, body: string): boolean {
    return status === 400 && body.toLowerCase().includes('content-moderat');
}

/* xAI reports exact costs in 'usd ticks', where 1 USD = 10^10 ticks. Both
 * success and moderation rejection payloads carry usage.cost_in_usd_ticks -
 * rejected generations are still billed. */
const USD_TICKS_PER_USD = 10_000_000_000;

export function extractGrokCostUsd(payload: unknown): number | undefined {
    const ticks = (payload as { usage?: { cost_in_usd_ticks?: unknown } })
        ?.usage?.cost_in_usd_ticks;

    if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks < 0) {
        return undefined;
    }

    return ticks / USD_TICKS_PER_USD;
}

function getTextParts(content: unknown): string[] {
    if (typeof content === 'string') {
        return [content];
    }

    if (Array.isArray(content)) {
        return content.flatMap(getTextParts);
    }

    if (!content || typeof content !== 'object') {
        return [];
    }

    const part = content as { type?: string; text?: unknown; content?: unknown };
    if (part.type && part.type !== 'text' && part.type !== 'output_text') {
        return [];
    }

    if (typeof part.text === 'string') {
        return [part.text];
    }

    return typeof part.content === 'string' ? [part.content] : [];
}

export function extractGrokResponseText(completion: unknown, hasImages: boolean): string | null {
    if (!completion || typeof completion !== 'object') {
        return null;
    }

    const data = completion as {
        choices?: Array<{ message?: XAIResponseMessage }>;
        output?: XAIResponseMessage[];
    };
    const assistantMessages = hasImages
        ? data.choices?.slice(0, 1).map(choice => choice.message).filter((message): message is XAIResponseMessage => Boolean(message)) || []
        : data.output?.filter(item => item.role === 'assistant') || [];
    const text = assistantMessages
        .flatMap(message => getTextParts(message.content))
        .map(part => part.trim())
        .filter(Boolean)
        .join('\n\n');

    return text || null;
}

export function stripGrokCitations(text: string): string {
    const citationLabel = String.raw`(?:\[\[\d+(?:,\s*\d+)*\]\]|\[\d+(?:,\s*\d+)*\])`;
    const citationLink = new RegExp(String.raw`\s*${citationLabel}\(<?https?:\/\/[^)\s>]+>?\)`, 'g');
    const bareCitation = new RegExp(String.raw`\s*(?:${citationLabel})+(?=(?:[.,;:!?])?(?:\s|$))`, 'g');

    return text
        .trim()
        .replace(citationLink, '')
        .replace(bareCitation, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([.,;:!?])/g, '$1')
        .trim();
}
