interface ClaudeContentBlockLike {
    type: string;
    text?: unknown;
}

interface ClaudeUsageLike {
    input_tokens?: number;
    output_tokens?: number;
}

interface ClaudeResponseLike {
    id?: string;
    model?: string;
    stop_reason?: string | null;
    content?: ClaudeContentBlockLike[];
    usage?: ClaudeUsageLike;
}

export function extractClaudeResponseText(content: ClaudeContentBlockLike[]): string {
    return content
        .filter((block): block is ClaudeContentBlockLike & { text: string } => (
            block.type === 'text' && typeof block.text === 'string'
        ))
        .map(block => block.text)
        .join('')
        .trim();
}

export function shouldRetryClaudeNoText(
    stopReason: string | null,
    retryCount: number,
    maxRetries: number,
): boolean {
    return retryCount < maxRetries
        && (stopReason === null || stopReason === 'end_turn' || stopReason === 'stop_sequence');
}

export function getClaudeNoTextError(stopReason: string | null): string {
    switch (stopReason) {
        case 'pause_turn':
            return 'Claude could not finish its web-search turn. Please try again.';
        case 'refusal':
            return 'Claude declined this request. Please try rephrasing it.';
        case 'max_tokens':
            return 'Claude used its token limit before producing an answer. Please simplify the request.';
        case 'tool_use':
            return 'Claude requested an unsupported tool action. Please try again.';
        default:
            return 'Claude returned no text after retrying. Please try again.';
    }
}

export function summarizeClaudeResponse(response: ClaudeResponseLike) {
    return {
        id: response.id,
        model: response.model,
        stopReason: response.stop_reason,
        contentTypes: response.content?.map(block => block.type) ?? [],
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
    };
}
