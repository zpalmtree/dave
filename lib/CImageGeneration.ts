import { AI_MODELS } from './AIModels.js';

export type CImageOutputFormat = 'png' | 'jpeg';

export type CImageGenerationTool = {
    type: 'image_generation';
    model: typeof AI_MODELS.openAIImage;
    moderation: 'low';
    output_format: CImageOutputFormat;
    output_compression?: number;
    background?: 'transparent';
    partial_images: number;
};

export function buildCImageGenerationTool(
    outputFormat: CImageOutputFormat,
    transparentBackground: boolean,
    partialImages: number,
): CImageGenerationTool {
    const effectiveOutputFormat = transparentBackground ? 'png' : outputFormat;

    return {
        type: 'image_generation',
        model: AI_MODELS.openAIImage,
        moderation: 'low',
        output_format: effectiveOutputFormat,
        ...(effectiveOutputFormat === 'jpeg' ? { output_compression: 50 } : {}),
        ...(transparentBackground ? { background: 'transparent' as const } : {}),
        partial_images: partialImages,
    };
}
