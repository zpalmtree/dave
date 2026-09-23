export type VideoReasoningEffort = 'low' | 'medium' | 'high';

export interface VideoTextModelCapabilities {
    provider: 'openai' | 'google' | 'anthropic';
    singlePass: boolean;
    streamingFirstFrame: boolean;
    efforts: readonly VideoReasoningEffort[];
}

const openai: VideoTextModelCapabilities = {
    provider: 'openai', singlePass: true, streamingFirstFrame: true,
    efforts: ['low', 'medium', 'high'],
};
const google: VideoTextModelCapabilities = {
    provider: 'google', singlePass: true, streamingFirstFrame: false,
    efforts: ['low', 'medium', 'high'],
};
const anthropic: VideoTextModelCapabilities = {
    provider: 'anthropic', singlePass: false, streamingFirstFrame: false,
    efforts: ['low', 'medium', 'high'],
};

/** Explicit API capabilities, verified against provider documentation and planner schemas on 2026-09-23. */
export const VIDEO_TEXT_MODELS: Readonly<Record<string, VideoTextModelCapabilities>> = {
    'gpt-6-astra': openai,
    'gpt-6-sol': openai,
    'gpt-5.6-sol': openai,
    'gpt-5.6-terra': openai,
    'gpt-5.6-luna': openai,
    'gemini-3.7-flash': google,
    'gemini-3.8-flash': google,
    'claude-opus-5-5': anthropic,
};

export function videoTextModelCapabilities(model: string): VideoTextModelCapabilities {
    const capabilities = VIDEO_TEXT_MODELS[model];
    if (!capabilities) throw new Error(`Unsupported video text model: ${model}.`);
    return capabilities;
}
