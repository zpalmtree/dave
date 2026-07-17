interface XAIResponseMessage {
    role: string;
    type?: string;
    content: unknown;
}

export function isGrokImageModerationRejection(status: number, body: string): boolean {
    return status === 400 && body.toLowerCase().includes('content-moderat');
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
