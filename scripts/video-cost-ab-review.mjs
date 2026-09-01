import { createHash } from 'node:crypto';

function assertPacket(packet, kind) {
    if (!packet || packet.schema_version !== 1 || packet.blinded !== true || !Array.isArray(packet.cases)) {
        throw new Error(`Invalid blinded ${kind} review packet.`);
    }
}

function reviewerPublicId(index) {
    return `r-${index + 1}`;
}

function plannerPublicId(index) {
    return `p-${index + 1}`;
}

function fingerprint(values) {
    return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24);
}

export function reviewerPacketFingerprint(packet) {
    assertPacket(packet, 'reviewer');
    return fingerprint(packet.cases.map(entry => [entry.case_id, entry.image_path]));
}

export function plannerPacketFingerprint(packet) {
    assertPacket(packet, 'planner');
    return fingerprint(packet.cases.map(entry => [entry.review_id, entry.options?.map(option => option.label)]));
}

export function sanitizeReviewerPacket(packet) {
    assertPacket(packet, 'reviewer');
    return {
        schema_version: 1,
        blinded: true,
        fingerprint: reviewerPacketFingerprint(packet),
        cases: packet.cases.map((entry, index) => ({
            public_id: reviewerPublicId(index),
            prompt: String(entry.prompt || ''),
            image_url: `/api/reviewer/${reviewerPublicId(index)}/image`,
            human_acceptable: typeof entry.human_acceptable === 'boolean' ? entry.human_acceptable : null,
            material_failure: typeof entry.material_failure === 'boolean' ? entry.material_failure : null,
            notes: String(entry.notes || ''),
        })),
    };
}

export function sanitizePlannerPacket(packet) {
    assertPacket(packet, 'planner');
    for (const entry of packet.cases) {
        const labels = (entry.options || []).map(option => option?.label).sort();
        if (labels.length !== 2 || labels[0] !== 'A' || labels[1] !== 'B') {
            throw new Error('Every planner review must contain blinded A and B options.');
        }
    }
    return {
        schema_version: 1,
        blinded: true,
        fingerprint: plannerPacketFingerprint(packet),
        cases: packet.cases.map((entry, index) => ({
            public_id: plannerPublicId(index),
            prompt: String(entry.prompt || ''),
            options: (entry.options || []).map(option => ({
                label: option.label,
                plan: option.plan,
            })),
            human_winner: ['A', 'B', 'tie'].includes(entry.human_winner) ? entry.human_winner : null,
            material_failures: Array.isArray(entry.material_failures)
                ? entry.material_failures.filter(label => ['A', 'B'].includes(label))
                : [],
            review_complete: entry.review_complete === true,
            notes: String(entry.notes || ''),
        })),
    };
}

function ratingsByPublicId(ratings) {
    if (!Array.isArray(ratings)) throw new Error('Ratings must be an array.');
    return new Map(ratings.map(entry => [entry?.public_id, entry]));
}

function nullableBoolean(value, field) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'boolean') throw new Error(`${field} must be true, false, or null.`);
    return value;
}

function notes(value) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'string') throw new Error('notes must be a string.');
    return value.slice(0, 4000);
}

export function applyReviewerRatings(packet, payload) {
    assertPacket(packet, 'reviewer');
    if (payload?.fingerprint !== reviewerPacketFingerprint(packet)) {
        throw new Error('The reviewer packet changed. Reload before saving.');
    }
    const ratings = ratingsByPublicId(payload?.cases);
    const knownIds = new Set(packet.cases.map((_entry, index) => reviewerPublicId(index)));
    for (const id of ratings.keys()) {
        if (!knownIds.has(id)) throw new Error(`Unknown reviewer case ${id}.`);
    }
    return {
        ...packet,
        cases: packet.cases.map((entry, index) => {
            const rating = ratings.get(reviewerPublicId(index));
            if (!rating) return entry;
            const humanAcceptable = nullableBoolean(rating.human_acceptable, 'human_acceptable');
            const materialFailure = nullableBoolean(rating.material_failure, 'material_failure');
            if ((humanAcceptable === null) !== (materialFailure === null)) {
                throw new Error('Reviewer cases must set both decisions together.');
            }
            return {
                ...entry,
                human_acceptable: humanAcceptable,
                material_failure: materialFailure,
                notes: notes(rating.notes),
            };
        }),
    };
}

export function applyPlannerRatings(packet, payload) {
    assertPacket(packet, 'planner');
    sanitizePlannerPacket(packet);
    if (payload?.fingerprint !== plannerPacketFingerprint(packet)) {
        throw new Error('The planner packet changed. Reload before saving.');
    }
    const ratings = ratingsByPublicId(payload?.cases);
    const knownIds = new Set(packet.cases.map((_entry, index) => plannerPublicId(index)));
    for (const id of ratings.keys()) {
        if (!knownIds.has(id)) throw new Error(`Unknown planner case ${id}.`);
    }
    return {
        ...packet,
        cases: packet.cases.map((entry, index) => {
            const rating = ratings.get(plannerPublicId(index));
            if (!rating) return entry;
            const winner = rating.human_winner ?? null;
            if (winner !== null && !['A', 'B', 'tie'].includes(winner)) {
                throw new Error('human_winner must be A, B, tie, or null.');
            }
            if (rating.review_complete === true && winner === null) {
                throw new Error('A completed planner review needs a winner or tie.');
            }
            if (rating.review_complete !== true && rating.review_complete !== false) {
                throw new Error('review_complete must be a boolean.');
            }
            if (!Array.isArray(rating.material_failures)
                || rating.material_failures.some(label => !['A', 'B'].includes(label))) {
                throw new Error('material_failures may contain only A and B.');
            }
            return {
                ...entry,
                human_winner: winner,
                material_failures: [...new Set(rating.material_failures)],
                review_complete: rating.review_complete,
                notes: notes(rating.notes),
            };
        }),
    };
}

export function reviewerImagePath(packet, publicId) {
    assertPacket(packet, 'reviewer');
    const match = /^r-(\d+)$/.exec(String(publicId));
    const index = match ? Number(match[1]) - 1 : -1;
    const path = packet.cases[index]?.image_path;
    if (!path || typeof path !== 'string') throw new Error('Unknown reviewer image.');
    return path;
}

export function reviewProgress(packet, kind) {
    assertPacket(packet, kind);
    const complete = kind === 'reviewer'
        ? packet.cases.filter(entry => typeof entry.human_acceptable === 'boolean'
            && typeof entry.material_failure === 'boolean').length
        : packet.cases.filter(entry => entry.review_complete === true
            && ['A', 'B', 'tie'].includes(entry.human_winner)).length;
    return { complete, total: packet.cases.length };
}
