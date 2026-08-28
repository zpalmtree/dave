/* Active provider model inventory. Keep custom fine-tunes pinned until a
 * replacement fine-tune has been trained and validated. */
export const AI_MODELS = {
    claudeChat: 'claude-opus-5',
    openAIChat: 'gpt-5.6-sol',
    openAITranscription: 'gpt-transcribe',
    openAIImage: 'gpt-image-2',
    geminiChat: 'gemini-3.7-flash',
    geminiPromptClassifier: 'gemini-3.5-flash-lite',
    geminiImage: 'gemini-3-pro-image',
    grokChat: 'grok-4.6',
    /* A/B testing found 4.5 faster and more natural for Discord recaps. */
    grokSummary: 'grok-4.5-latest',
    grokImage: 'grok-imagine-image-2.0',
    gabChat: 'arya',
} as const;

export const AI_REQUEST_TIMEOUTS = {
    // xAI recommends a six-minute client timeout for reasoning models.
    grokText: 6 * 60 * 1000,
    // Grok Imagine 2.0 can need longer than one minute to render.
    grokImage: 3 * 60 * 1000,
} as const;

export const OPENAI_FINE_TUNED_MODELS = {
    davinciV4: 'ft:gpt-3.5-turbo-1106:personal:davinci-v4:8VuOwuOa',
    fitQuoteV19: 'ft:gpt-3.5-turbo-1106:personal:fit-quote-bot-v19:8NYAVNzk',
    slugQuoteV2: 'ft:gpt-3.5-turbo-1106:personal:slug-quote-bot-v2:8NC8XipH',
    bugglesV41: 'ft:gpt-4o-2024-08-06:personal:buggles-v41:AoPLqrVu:ckpt-step-1932',
} as const;
