import { createHash } from 'node:crypto';

export const EXPERIENCE_DIMENSIONS = ['creative', 'identity', 'audio'];
export const MUSIC_DIMENSIONS = ['genre', 'coherence', 'audio'];
export const SCORE_TIMING_DIMENSIONS = ['timing', 'restraint', 'audio'];

function assertPacket(packet) {
    if (!packet || packet.schema_version !== 1 || packet.blinded !== true || !Array.isArray(packet.pairs)) {
        throw new Error('Invalid blinded final-video packet.');
    }
    if (packet.rubric !== undefined && ![EXPERIENCE_DIMENSIONS, MUSIC_DIMENSIONS, SCORE_TIMING_DIMENSIONS].some(rubric => JSON.stringify(packet.rubric) === JSON.stringify(rubric))) {
        throw new Error('Unknown final-video review rubric.');
    }
}

function dimensionChoices(value = {}, dimensions = EXPERIENCE_DIMENSIONS) {
    return Object.fromEntries(dimensions.map(key => {
        const choice = value?.[key] ?? null;
        if (choice !== null && !['A', 'B', 'tie', ...(key === 'identity' ? ['na'] : [])].includes(choice)) {
            throw new Error(`Invalid ${key} preference.`);
        }
        return [key, choice];
    }));
}

function publicId(index) {
    return `v-${index + 1}`;
}

function fingerprint(values) {
    return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24);
}

function nullableRating(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

export function finalVideoPacketFingerprint(packet) {
    assertPacket(packet);
    const pairs = packet.pairs.map(pair => [pair.pair_id, pair.videos?.map(video => [video.label, video.video_path])]);
    return fingerprint(packet.rubric ? [packet.rubric, pairs] : pairs);
}

export function sanitizeFinalVideoPacket(packet) {
    assertPacket(packet);
    for (const pair of packet.pairs) {
        const labels = (pair.videos || []).map(video => video?.label).sort();
        if (labels.length !== 2 || labels[0] !== 'A' || labels[1] !== 'B') {
            throw new Error('Every final-video pair must contain blinded A and B videos.');
        }
    }
    return {
        schema_version: 1,
        blinded: true,
        ...(packet.rubric ? { rubric: packet.rubric } : {}),
        fingerprint: finalVideoPacketFingerprint(packet),
        pairs: packet.pairs.map((pair, index) => ({
            public_id: publicId(index),
            prompt: String(pair.prompt || ''),
            videos: pair.videos.map(video => ({
                label: video.label,
                video_url: `/api/final/${publicId(index)}/video/${video.label}`,
            })),
            preferred: ['A', 'B', 'tie'].includes(pair.preferred) ? pair.preferred : null,
            ...(packet.rubric ? { dimension_preferences: dimensionChoices(pair.dimension_preferences, packet.rubric) } : {}),
            overall: {
                A: nullableRating(pair.overall?.A),
                B: nullableRating(pair.overall?.B),
            },
            material_failure: {
                A: pair.material_failure?.A === true,
                B: pair.material_failure?.B === true,
            },
            notes: String(pair.notes || ''),
        })),
    };
}

function ratingNumber(value, field) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 1 || number > 10) throw new Error(`${field} must be from 1 to 10.`);
    return number;
}

export function applyFinalVideoRatings(packet, payload) {
    assertPacket(packet);
    if (payload?.fingerprint !== finalVideoPacketFingerprint(packet)) {
        throw new Error('The final-video packet changed. Reload before saving.');
    }
    if (!Array.isArray(payload?.pairs)) throw new Error('Ratings must be an array.');
    const ratings = new Map(payload.pairs.map(pair => [pair?.public_id, pair]));
    const known = new Set(packet.pairs.map((_pair, index) => publicId(index)));
    for (const id of ratings.keys()) if (!known.has(id)) throw new Error(`Unknown final-video pair ${id}.`);
    return {
        ...packet,
        pairs: packet.pairs.map((pair, index) => {
            const rating = ratings.get(publicId(index));
            if (!rating) return pair;
            const preferred = rating.preferred ?? null;
            if (preferred !== null && !['A', 'B', 'tie'].includes(preferred)) {
                throw new Error('preferred must be A, B, tie, or null.');
            }
            const overall = {
                A: ratingNumber(rating.overall?.A, 'overall.A'),
                B: ratingNumber(rating.overall?.B, 'overall.B'),
            };
            const dimensions = packet.rubric ? dimensionChoices(rating.dimension_preferences, packet.rubric) : null;
            if (preferred !== null && dimensions && Object.values(dimensions).some(value => value === null)) {
                throw new Error(`A completed pair requires ${packet.rubric.slice(0, -1).join(', ')} and ${packet.rubric.at(-1)} preferences.`);
            }
            if (preferred !== null && !dimensions && (overall.A === null || overall.B === null)) {
                throw new Error('A completed pair requires both overall scores.');
            }
            if (!rating.material_failure || typeof rating.material_failure.A !== 'boolean'
                || typeof rating.material_failure.B !== 'boolean') {
                throw new Error('material_failure must contain booleans for A and B.');
            }
            return {
                ...pair,
                preferred,
                overall,
                ...(dimensions ? { dimension_preferences: dimensions } : {}),
                material_failure: {
                    A: rating.material_failure.A,
                    B: rating.material_failure.B,
                },
                notes: typeof rating.notes === 'string' ? rating.notes.slice(0, 4000) : '',
            };
        }),
    };
}

export function finalVideoPath(packet, id, label) {
    assertPacket(packet);
    const match = /^v-(\d+)$/.exec(String(id));
    const index = match ? Number(match[1]) - 1 : -1;
    const path = packet.pairs[index]?.videos?.find(video => video.label === label)?.video_path;
    if (!path || typeof path !== 'string' || !['A', 'B'].includes(label)) throw new Error('Unknown final-review video.');
    return path;
}

export function finalVideoProgress(packet) {
    assertPacket(packet);
    const complete = packet.pairs.filter(pair => ['A', 'B', 'tie'].includes(pair.preferred)
        && (packet.rubric
            ? Object.values(dimensionChoices(pair.dimension_preferences, packet.rubric)).every(value => value !== null)
            : ['A', 'B'].every(label => nullableRating(pair.overall?.[label]) !== null))).length;
    return { complete, total: packet.pairs.length };
}
