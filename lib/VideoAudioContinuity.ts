export const VIDEO_AUDIO_CONTINUITY_INSTRUCTIONS = `Define speaker_profiles once for the whole video, with one speaker_id and voice_description for each speaking character. Keep speaker_id identical across scenes. voice_description fixes accent, habitual pitch range, resonance, texture, and cadence; respect any supplied character voice description. Keep momentary emotion and performance in dialogue.delivery, without changing that underlying identity. Use an empty array for no speech. Reuse the same environmental sound description across shots in a continuous location, allowing intentional changes in distance and acoustics. Keep requested music instrumentation, tempo, and key consistent across segments.
Choose segment.audio_transition independently from the picture transition: auto uses short seam fades at cuts and an audio crossfade at a picture dissolve; cut preserves an intentional abrupt sound change; fade uses short seam fades even across a picture dissolve. These are edits of the combined audio, not separate ambience tracks. Never rely on them to continue a spoken sentence or music phrase across independently generated clips; finish spoken turns before a segment boundary.`;

export const VIDEO_SPEAKER_PROFILES_SCHEMA = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        required: ['speaker_id', 'voice_description'],
        properties: {
            speaker_id: { type: 'string' },
            voice_description: { type: 'string' },
        },
    },
} as const;

/** Old plans acquire a stable profile from the first turn, without changing words or delivery. */
export function normalizeVideoAudioContinuity(plan: Record<string, any>): void {
    const profiles = new Map<string, { speaker_id: string; voice_description: string }>();
    if (plan.speaker_profiles !== undefined && !Array.isArray(plan.speaker_profiles)) {
        throw new Error('speaker_profiles must be an array.');
    }
    for (const profile of plan.speaker_profiles || []) {
        const id = String(profile?.speaker_id || '').trim();
        const voice = String(profile?.voice_description || '').trim();
        if (!id || !voice || profiles.has(id.toLowerCase())) {
            throw new Error('Speaker profiles require unique speaker IDs and nonempty voice descriptions.');
        }
        profiles.set(id.toLowerCase(), { speaker_id: id, voice_description: voice });
    }
    for (const segment of plan.segments || []) {
        const transition = segment.audio_transition ?? 'auto';
        if (!['auto', 'cut', 'fade'].includes(transition)) {
            throw new Error(`Invalid audio transition: ${transition}`);
        }
        segment.audio_transition = transition;
        for (const shot of segment.shots || []) {
            for (const line of shot.dialogue || []) {
                const id = String(line.speaker_id || '').trim();
                if (id && !profiles.has(id.toLowerCase())) {
                    profiles.set(id.toLowerCase(), {
                        speaker_id: id,
                        voice_description: String(line.delivery || 'natural voice').trim() || 'natural voice',
                    });
                }
            }
        }
    }
    plan.speaker_profiles = [...profiles.values()];
}
