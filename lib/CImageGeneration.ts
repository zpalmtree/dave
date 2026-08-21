export type CImageOutputFormat = 'png' | 'jpeg';

export type CImageGenerationTool = {
    type: 'image_generation';
    model: 'gpt-image-2';
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
        model: 'gpt-image-2',
        moderation: 'low',
        output_format: effectiveOutputFormat,
        ...(effectiveOutputFormat === 'jpeg' ? { output_compression: 50 } : {}),
        ...(transparentBackground ? { background: 'transparent' as const } : {}),
        partial_images: partialImages,
    };
}
