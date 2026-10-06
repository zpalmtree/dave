import { readFileSync } from 'fs';

import { VIDEO_IMAGE_ONLY_AUTO_PROMPT, VIDEO_SOURCE_COMPOSITION_TIMEOUT_MS, VideoSourceCompositeProvider } from './VideoProtocol.js';
import { VideoKeyframeError, VideoKeyframeResult, createFrontierVideoKeyframe } from './VideoKeyframeProvider.js';
import { VideoKeyframeReference } from './VideoKeyframeReferences.js';
import { VideoProviderHooks, VideoUsagePersistenceError } from './VideoUsage.js';
import { StoredVideoSourceImage } from './VideoSourceImage.js';

export function oalgoSourceImageCompositePlan(prompt: string): Record<string, unknown> {
    const requestedAction = prompt === VIDEO_IMAGE_ONLY_AUTO_PROMPT
        ? 'Add Meximutt to the attached situation. Preserve its existing subjects and action; a later screenplay will plan the motion.'
        : `Stage the combined image so it can naturally begin this requested video: ${prompt}`;
    return {
        intent: requestedAction,
        keyframe: {
            recommended: true,
            reason: 'Combine the built-in Meximutt art with the user-supplied visual reference.',
            prompt: [
                'Edit the scene in Reference 2 by adding Meximutt from Reference 1 as one additional, separate person.',
                'Keep every main subject from Reference 2 visible and recognizable, keeping their own clothing, equipment, and story-defining props with their original owners. Meximutt joins them; he does not replace, merge with, or dress as any existing subject.',
                'Use the Meximutt base image directly for his face, hair silhouette, huge full cheeks and jowls, heavy torso, and Mexican-flag clothing. Preserve his distinctive proportions and photographic texture instead of redesigning him from a description.',
                'Keep the attached setting and the relationships between its subjects. Make room beside them for Meximutt, widening the view only as needed. Keep his face large enough to recognize and the attached subjects unobscured.',
                'Render a unified scene with consistent perspective, lighting, and texture, never a split screen, side-by-side layout, pasted rectangle, or collage.',
                requestedAction,
            ].join(' '),
            reference_requirements: [],
            motion_contract: {
                subject_orientation: 'Keep all subjects oriented for the opening action.',
                gaze_direction: 'Direct each visible gaze toward the opening action or another subject.',
                travel_direction: 'Give moving subjects clear space in their intended direction.',
                camera_relation: 'Use a coherent single camera view wide enough to show recognizable Meximutt, the attached subjects, and their story-defining props with clear sightlines for interaction.',
                first_second_action: requestedAction,
            },
        },
        segments: [],
    };
}

export async function composeOalgoSourceImages(
    base: StoredVideoSourceImage,
    attached: StoredVideoSourceImage,
    prompt: string,
    hooks: VideoProviderHooks,
    provider: VideoSourceCompositeProvider = 'sunburst',
): Promise<VideoKeyframeResult> {
    if (provider !== 'sunburst' && provider !== 'grok') throw new Error('Unknown source image provider.');
    const references: VideoKeyframeReference[] = [
        {
            label: 'Meximutt base image',
            // identity, not style: only an identity reference makes the supplied image the
            // authority for face and body. Declared as style, the composite kept the shirt
            // and palette and replaced Meximutt with a generic man.
            kind: 'identity',
            visualFactsToPreserve: 'This image is the authority for who Meximutt is. Preserve his exact facial anatomy, head and body proportions, and hair shape, along with the Mexican flag clothing and emblem, rendering style, and palette. Allow a wider or rebalanced composition and an attached-scene setting so Meximutt can visibly interact with the attached subjects, but never substitute a different man, slim his build, or restyle his hair.',
            bytes: readFileSync(base.path),
            mimeType: base.mimeType,
            sourceUrl: 'built-in:meximutt',
            contextUrl: 'built-in:meximutt',
        },
        {
            label: 'User-attached image',
            kind: 'object',
            visualFactsToPreserve: 'Preserve the main depicted subjects, their recognizable appearance and relevant pose, and their relationships to story-defining props. Keep prominent people or animals visible rather than substituting a nearby object. Integrate Meximutt into this visual situation with room for interaction.',
            bytes: readFileSync(attached.path),
            mimeType: attached.mimeType,
            sourceUrl: 'discord-attachment',
            contextUrl: 'discord-attachment',
        },
    ];
    // A corrective image needs a full review too; the old five-minute cap could
    // expire just after paying for that second image.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VIDEO_SOURCE_COMPOSITION_TIMEOUT_MS);
    try {
        return await createFrontierVideoKeyframe(
            oalgoSourceImageCompositePlan(prompt),
            references,
            {
                ...hooks,
                aspectRatio: '1:1',
                requireIdentityPreservation: true,
                reviewPurpose: 'source-composite',
                sourceCompositeProvider: provider,
                abortSignal: controller.signal,
            },
        );
    } catch (error) {
        if (error instanceof VideoUsagePersistenceError) throw error;
        if (controller.signal.aborted) {
            throw new VideoKeyframeError('timeout', 'Meximutt image composition exceeded its time limit.');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

export function oalgoCompositionFailureMessage(error: unknown): string {
    const prefix = 'Could not combine Meximutt with your attached image. No video was queued.';
    if (error instanceof VideoKeyframeError) {
        switch (error.code) {
            case 'moderation':
                return `${prefix} The image provider declined this combination under its safety rules. Repeating the same request is unlikely to help.`;
            case 'identity_review':
                return `${prefix} The generated images changed Meximutt's likeness, even after a repair. You can retry the composition.`;
            case 'composition_review':
                return `${prefix} The generated images did not preserve the attached scene, even after a repair. You can retry the composition.`;
            case 'review_unavailable':
                return `${prefix} The image review service was unavailable, so the result could not be verified. Please try again later.`;
            case 'timeout':
                return `${prefix} Combining and checking the images took too long. Please try again later.`;
        }
    }
    return `${prefix} The image service could not complete the composition. Please try again later.`;
}
