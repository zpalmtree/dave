import { AI_MODELS } from './AIModels.js';

export type CImageOutputFormat = 'png' | 'jpeg';

export type CImageGenerationTool = {
    type: 'image_generation';
    model: typeof AI_MODELS.openAICImage | typeof AI_MODELS.openAIImage;
    moderation: 'low';
    output_format: CImageOutputFormat;
    output_compression?: number;
    background?: 'transparent';
};

export function buildCImageGenerationTool(
    outputFormat: CImageOutputFormat,
    transparentBackground: boolean,
    hasInputImages: boolean = false,
): CImageGenerationTool {
    const effectiveOutputFormat = transparentBackground ? 'png' : outputFormat;

    return {
        type: 'image_generation',
        model: hasInputImages ? AI_MODELS.openAIImage : AI_MODELS.openAICImage,
        moderation: 'low',
        output_format: effectiveOutputFormat,
        ...(effectiveOutputFormat === 'jpeg' ? { output_compression: 50 } : {}),
        ...(transparentBackground ? { background: 'transparent' as const } : {}),
    };
}

/** Try Sunburst after Flare exhausts the SDK's retries for a server failure. */
export async function generateCImageWithFallback<T>(
    tool: CImageGenerationTool,
    generate: (tool: CImageGenerationTool) => Promise<T>,
): Promise<T> {
    try {
        return await generate(tool);
    } catch (error) {
        const status = (error as { status?: unknown } | null)?.status;
        if (tool.model !== AI_MODELS.openAICImage
            || typeof status !== 'number'
            || status < 500 || status >= 600) {
            throw error;
        }

        console.warn(`[CImage] ${tool.model} returned HTTP ${status}; retrying with ${AI_MODELS.openAIImage}.`);
        return generate({ ...tool, model: AI_MODELS.openAIImage });
    }
}
