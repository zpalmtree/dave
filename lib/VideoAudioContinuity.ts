export const VIDEO_AUDIO_CONTINUITY_INSTRUCTIONS = `Define speaker_profiles once for the whole video, with one speaker_id and voice_description for each speaking character. Keep speaker_id identical across scenes. voice_description fixes accent, habitual pitch range, resonance, texture, and cadence; respect any supplied character voice description. Keep momentary emotion and performance in dialogue.delivery, without changing that underlying identity. Use an empty array for no speech. Reuse the same environmental sound description across shots in a continuous location, allowing intentional changes in distance and acoustics. Keep requested music instrumentation, tempo, and key consistent across segments.
For each voice, explicitly preserve the intended vocal gender/presentation, age range, accent, and register across all scenes; never recast a speaker because the camera or emotional delivery changes. A narrator and a visible character are separate identities unless the request identifies them as the same speaker. Describe an off-screen narrator or voice-over with the literal phrase off-screen in that speaker's voice_description. Keep their words in dialogue but never make a visible character mouth them. When a speaker intentionally moves on- or off-screen, state on-screen or off-screen in that turn's dialogue.delivery; this changes staging, not voice identity. Do not invent a narrator to replace a requested character's own speech.
Choose segment.audio_transition independently from the picture transition: auto uses short seam fades at cuts and an audio crossfade at a picture dissolve; cut preserves an intentional abrupt sound change; fade uses short seam fades even across a picture dissolve. These are edits of the combined audio, not separate ambience tracks. Never rely on them to continue a spoken sentence or music phrase across independently generated clips; finish spoken turns before a segment boundary.`;

export const VIDEO_SOUND_MIX_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['music', 'caption', 'reason', 'effects'],
    properties: {
        music: { type: 'string', enum: ['none', 'instrumental'] },
        caption: { type: 'string' }, reason: { type: 'string' },
        effects: { type: 'string', enum: ['preserve', 'soften_transients'] },
    },
} as const;

export const VIDEO_SOUND_MIX_INSTRUCTIONS = `Choose sound_mix once for the entire video. Music is optional creative material: choose music=instrumental when one restrained score improves pacing, wonder, beauty or comic timing, including underneath dialogue. Its caption describes one instrumental arrangement, instrumentation, tempo and development across the whole video; no vocals or lyrics. After rendering, a composer develops a concrete musical brief from the finished footage, generates one performance, and an audiovisual editor chooses instrumental passages, cue timing, fades or no added music. The mixer ducks selected passages beneath speech and prominent sounds. Set every segment.music to N/A when using this bed, so independently rendered scenes do not invent competing music. Choose music=none and an empty caption for intentional quiet, sound-focused or ASMR scenes, explicit no-music/silence requests, or an existing supplied/song soundtrack. Give a short reason for either choice; do not add music merely to fill space.
Choose effects=preserve normally. soften_transients is a conservative reduction of peaks in the entire generated mix, not isolated sound-effect editing; use it only for quiet dialogue-free videos with delicate sounds, never for dialogue, singing, music-led edits or deliberately forceful impacts. Describe proportionate sound at generation time regardless of this choice. A leaf settling, distant footstep or fabric movement can be almost inaudible. Preserve purposeful quiet; not every visible movement needs a foreground effect.`;

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
export function normalizeVideoAudioContinuity(plan: Record<string, any>, rawPrompt = ''): void {
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
    const mix = plan.sound_mix;
    if (mix !== undefined && (!mix || !['none', 'instrumental'].includes(mix.music)
        || !['preserve', 'soften_transients'].includes(mix.effects)
        || typeof mix.caption !== 'string' || typeof mix.reason !== 'string'
        || (mix.music === 'instrumental' && mix.caption.trim().length < 20))) {
        throw new Error('Invalid sound_mix directive.');
    }
    plan.sound_mix = mix ? { ...mix, caption: mix.caption.trim().slice(0, 2000), reason: mix.reason.slice(0, 500) }
        : { music: 'none', caption: '', reason: 'Legacy plan; preserve its soundtrack.', effects: 'preserve' };
    const noMusic = /\b(?:no|without)\s+(?:any\s+)?(?:background\s+)?(?:music|score|soundtrack)\b|\b(?:no audio|no sound|complete silence|silence only|only (?:ambience|sound effects))\b/i.test(rawPrompt);
    if (plan.source_audio || noMusic) {
        plan.sound_mix.music = 'none';
        plan.sound_mix.caption = '';
    }
    const speaks = (plan.segments || []).some((s: any) => (s.shots || []).some((shot: any) => shot.dialogue?.length));
    if (speaks || plan.source_audio) plan.sound_mix.effects = 'preserve';
    if (plan.sound_mix.music === 'instrumental' || noMusic) {
        for (const segment of plan.segments || []) segment.music = 'N/A';
    }
}
