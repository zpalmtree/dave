export type VideoImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

/** Anything other than JPEG or WebP is stored as PNG. */
export function imageExtension(mimeType: string): string {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    return 'png';
}

export function mimeTypeForExtension(extension: string): VideoImageMimeType {
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'webp') return 'image/webp';
    return 'image/png';
}
