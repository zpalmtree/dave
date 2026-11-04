import { fetchPublicMedia, publicMediaUrl, discardMediaResponse } from './PublicMedia.js';

/**
 * Discord shows animated PNGs like GIFs, so an APNG source must be edited as a clip and
 * delivered as a GIF. Discord's IsAnimated attachment flag marks animated images; for a
 * PNG without it, the file's own chunks decide: an APNG declares acTL before its first IDAT.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_BYTES = 64 * 1024;
const sniffed = new WeakSet<object>();

type Attachment = { url?: string; name?: string | null; contentType?: string | null; flags?: unknown };
type Message = { attachments?: { values(): Iterable<Attachment> } } | null | undefined;
type Fetcher = typeof fetchPublicMedia;

/** True when the PNG bytes declare animation (acTL) before image data (IDAT). */
export function isAnimatedPngData(data: Buffer): boolean {
    if (data.length < 16 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
    let offset = 8;
    while (offset + 8 <= data.length) {
        const length = data.readUInt32BE(offset);
        const type = data.toString('latin1', offset + 4, offset + 8);
        if (type === 'acTL') return true;
        if (type === 'IDAT' || type === 'IEND') return false;
        offset += 12 + length;
    }
    return false;
}

export function isPngAttachment(attachment: Attachment): boolean {
    const mime = attachment.contentType?.split(';')[0].toLowerCase();
    return mime === 'image/png' || mime === 'image/apng' || /\.a?png$/i.test(attachment.name || '');
}

function animatedFlag(attachment: Attachment): boolean {
    const flags = attachment.flags as { bitfield?: number } | number | null | undefined;
    return ((Number(typeof flags === 'object' ? flags?.bitfield : flags) || 0) & 32) !== 0;
}

/** Discord's AttachmentFlags.IsAnimated, or a sniffed acTL chunk; still PNGs remain images. */
export function isAnimatedPngAttachment(attachment: Attachment): boolean {
    return isPngAttachment(attachment) && (animatedFlag(attachment) || sniffed.has(attachment));
}

async function headerBytes(url: string, fetcher: Fetcher): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    // fetchPublicMedia sets its own headers, so read the start of the body and abort.
    const response = await fetcher(url, { signal: controller.signal } as any);
    try {
        if (!response.ok || !response.body) return Buffer.alloc(0);
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of response.body as AsyncIterable<Buffer>) {
            chunks.push(Buffer.from(chunk));
            total += chunk.length;
            if (total >= HEADER_BYTES) break;
        }
        return Buffer.concat(chunks).subarray(0, HEADER_BYTES);
    } finally {
        clearTimeout(timer);
        controller.abort();
        discardMediaResponse(response);
    }
}

/**
 * Read the start of each unflagged PNG attachment once, before the synchronous source
 * classification runs. A failed read leaves the attachment a still image.
 */
export async function detectAnimatedPngs(messages: Message[], fetcher: Fetcher = fetchPublicMedia): Promise<void> {
    const pending: Attachment[] = [];
    for (const message of messages) {
        for (const attachment of message?.attachments?.values() || []) {
            if (isPngAttachment(attachment) && !animatedFlag(attachment) && !sniffed.has(attachment)
                && attachment.url && publicMediaUrl(attachment.url)) pending.push(attachment);
        }
    }
    await Promise.all(pending.slice(0, 4).map(async attachment => {
        try {
            if (isAnimatedPngData(await headerBytes(attachment.url!, fetcher))) sniffed.add(attachment);
        } catch {
            // Unreadable headers keep the attachment as a still image.
        }
    }));
}
