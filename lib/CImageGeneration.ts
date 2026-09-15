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
