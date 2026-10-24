import { readFileSync } from 'fs';

import { VIDEO_IMAGE_ONLY_AUTO_PROMPT, VIDEO_SOURCE_COMPOSITION_TIMEOUT_MS, VideoSourceCompositeProvider } from './VideoProtocol.js';
import { VideoKeyframeError, VideoKeyframeResult, createFrontierVideoKeyframe } from './VideoKeyframeProvider.js';
import { VideoKeyframeReference } from './VideoKeyframeReferences.js';
import { VideoProviderHooks, VideoUsagePersistenceError } from './VideoUsage.js';
import { StoredVideoSourceImage } from './VideoSourceImage.js';
import { MEXIMUTT, VideoCharacter } from './VideoCharacters.js';

/** Stage the opening before screenplay planning, which will treat the result as frame zero. */
export function oalgoSceneOpeningPlan(prompt: string): Record<string, unknown> {
    return {
        intent: prompt,
        keyframe: {
            recommended: true,
            reason: 'Put Meximutt directly into the requested scene before video planning.',
            prompt: [
                `Create the opening instant of this video request: ${prompt}`,
                'Use Reference 1 only as the authority for Meximutt\'s identity: preserve his exact face, hair shape, huge full cheeks and jowls, heavy torso, and Mexican-flag clothing.',
                'Stage him already in the requested setting, with the other participants and story-defining props needed for the first action. Replace the reference background, crop, and pose as needed for this scene.',
                'Choose the earliest useful moment before the first action or spoken exchange. Do not show later events, the outcome, or a montage of the whole story. Do not turn dialogue into captions or speech bubbles.',
                'Keep his face recognizable and his mouth visible for speech. Match perspective and lighting across one coherent scene, with space and clear sightlines for the opening interaction.',
                'Keep photographic live-action texture unless the request explicitly asks for another style.',
            ].join(' '),
            reference_requirements: [],
        },
        segments: [],
    };
}

export async function createOalgoSceneOpening(
    base: StoredVideoSourceImage,
    prompt: string,
    hooks: VideoProviderHooks,
    generator = createFrontierVideoKeyframe,
): Promise<VideoKeyframeResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VIDEO_SOURCE_COMPOSITION_TIMEOUT_MS);
    try {
        const result = await generator(oalgoSceneOpeningPlan(prompt), [{
            label: 'Original Meximutt identity', kind: 'identity',
            visualFactsToPreserve: 'Preserve the exact individual: face, hair silhouette, full cheeks and jowls, heavy body proportions, and Mexican-flag clothing. The background, pose, and camera framing may change to fit the requested opening.',
            bytes: readFileSync(base.path), mimeType: base.mimeType,
            sourceUrl: 'built-in:meximutt', contextUrl: 'built-in:meximutt',
        }], {
            ...hooks, aspectRatio: '1:1', requireIdentityPreservation: true,
            reviewPurpose: 'character-opening', abortSignal: controller.signal,
        });
        // Other keyframe paths may return best effort or unreviewed images. Here
        // the known-good portrait is preferable to an unverified replacement.
        if (result.reviewStatus !== 'accepted') {
            throw new VideoKeyframeError('identity_review', 'The scene opening did not pass visual and identity review.');
        }
        return result;
    } catch (error) {
        if (error instanceof VideoUsagePersistenceError) throw error;
        if (controller.signal.aborted) throw new VideoKeyframeError('timeout', 'Scene opening generation exceeded its time limit.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

export function oalgoSourceImageCompositePlan(prompt: string, character: VideoCharacter = MEXIMUTT): Record<string, unknown> {
    const { name } = character;
    const requestedAction = prompt === VIDEO_IMAGE_ONLY_AUTO_PROMPT
        ? `Add ${name} to the attached situation. Preserve its existing subjects and action; a later screenplay will plan the motion.`
        : `Stage the combined image so it can naturally begin this requested video: ${prompt}`;
    return {
        intent: requestedAction,
        keyframe: {
            recommended: true,
            reason: `Combine the built-in ${name} art with the user-supplied visual reference.`,
            prompt: [
                `Edit the scene in Reference 2 by adding ${name} from Reference 1 as one additional, separate person.`,
                `Keep every main subject from Reference 2 visible and recognizable, keeping their own clothing, equipment, and story-defining props with their original owners. ${name} joins them; he does not replace, merge with, or dress as any existing subject.`,
                `Use the ${name} base image directly for his face, hair silhouette, huge full cheeks and jowls, heavy torso, and ${character.clothing}. Preserve his distinctive proportions and photographic texture instead of redesigning him from a description.`,
                `Keep the attached setting and the relationships between its subjects. Make room beside them for ${name}, widening the view only as needed. Keep his face large enough to recognize and the attached subjects unobscured.`,
                'Render a unified scene with consistent perspective, lighting, and texture, never a split screen, side-by-side layout, pasted rectangle, or collage.',
                requestedAction,
            ].join(' '),
            reference_requirements: [],
            motion_contract: {
                subject_orientation: 'Keep all subjects oriented for the opening action.',
                gaze_direction: 'Direct each visible gaze toward the opening action or another subject.',
                travel_direction: 'Give moving subjects clear space in their intended direction.',
                camera_relation: `Use a coherent single camera view wide enough to show recognizable ${name}, the attached subjects, and their story-defining props with clear sightlines for interaction.`,
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
    character: VideoCharacter = MEXIMUTT,
): Promise<VideoKeyframeResult> {
    const { name } = character;
    if (provider !== 'sunburst' && provider !== 'grok') throw new Error('Unknown source image provider.');
    const references: VideoKeyframeReference[] = [
        {
            label: `${name} base image`,
            // identity, not style: only an identity reference makes the supplied image the
            // authority for face and body. Declared as style, the composite kept the shirt
            // and palette and replaced the character with a generic man.
            kind: 'identity',
            visualFactsToPreserve: `This image is the authority for who ${name} is. Preserve his exact facial anatomy, head and body proportions, and hair shape, along with ${character.clothingAndEmblem}, rendering style, and palette. Allow a wider or rebalanced composition and an attached-scene setting so ${name} can visibly interact with the attached subjects, but never substitute a different man, slim his build, or restyle his hair.`,
            bytes: readFileSync(base.path),
            mimeType: base.mimeType,
            sourceUrl: `built-in:${character.id}`,
            contextUrl: `built-in:${character.id}`,
        },
        {
            label: 'User-attached image',
            kind: 'object',
            visualFactsToPreserve: `Preserve the main depicted subjects, their recognizable appearance and relevant pose, and their relationships to story-defining props. Keep prominent people or animals visible rather than substituting a nearby object. Integrate ${name} into this visual situation with room for interaction.`,
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
            oalgoSourceImageCompositePlan(prompt, character),
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
            throw new VideoKeyframeError('timeout', `${name} image composition exceeded its time limit.`);
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
