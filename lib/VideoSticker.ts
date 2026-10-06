import { StickerFormatType } from 'discord.js';

export interface VideoStickerSourceImage {
    sticker_id: string;
    sticker_format: StickerFormatType;
    name: string;
}

export function videoStickerSourceImage(value: any): VideoStickerSourceImage {
    if (typeof value.sticker_id !== 'string' || !/^\d{17,20}$/.test(value.sticker_id)) {
        throw new Error('Invalid Discord sticker ID.');
    }
    if (![StickerFormatType.PNG, StickerFormatType.APNG, StickerFormatType.GIF].includes(value.sticker_format)) {
        throw new Error('This sticker format is not supported. Attach a PNG of the sticker instead.');
    }
    return {
        sticker_id: value.sticker_id,
        sticker_format: value.sticker_format,
        name: String(value.name || 'sticker').slice(0, 255),
    };
}

/** Discord's media proxy flattens animated stickers to a still PNG. */
export function videoStickerFrameUrl(value: VideoStickerSourceImage): string {
    const sticker = videoStickerSourceImage(value);
    const extension = sticker.sticker_format === StickerFormatType.GIF ? 'gif' : 'png';
    return `https://media.discordapp.net/stickers/${sticker.sticker_id}.${extension}?format=png&passthrough=false`;
}
