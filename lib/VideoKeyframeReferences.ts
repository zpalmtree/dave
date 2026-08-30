import { createHash } from 'crypto';
import { GoogleGenAI } from '@google/genai';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';

import { config } from './Config.js';
import { VideoProviderHooks, VideoUsagePersistenceError } from './VideoUsage.js';
import {
    ImageSearchResult,
    DownloadedImage,
    downloadSearchResultImage,
    isUsableImageResult,
} from './ImageSearch.js';

export const VIDEO_KEYFRAME_MAX_REFERENCES = 4;
export const VIDEO_KEYFRAME_REFERENCE_VALIDATION_MODEL = 'gemini-3.5-flash-lite';

export type VideoKeyframeReferenceKind = 'identity' | 'character' | 'object' | 'location' | 'style';

export interface VideoKeyframeReferenceRequirement {
    label: string;
    kind: VideoKeyframeReferenceKind;
    searchQuery: string;
    visualFactsToPreserve: string;
}

export interface VideoKeyframeReference {
    label: string;
    kind: VideoKeyframeReferenceKind;
    visualFactsToPreserve: string;
    bytes: Buffer;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    sourceUrl: string;
    contextUrl: string;
}

interface CachedReference {
    label: string;
    kind: VideoKeyframeReferenceKind;
    visual_facts_to_preserve: string;
    source_url: string;
    context_url: string;
    filename: string;
}

interface ReferenceManifest {
    version: 1;
    requirements_sha256: string;
    references: CachedReference[];
}

type SearchImages = (query: string) => Promise<ImageSearchResult[]>;
type DownloadImage = typeof downloadSearchResultImage;
type ValidateReference = (
    requirement: VideoKeyframeReferenceRequirement,
    result: ImageSearchResult,
    image: DownloadedImage,
    hooks: VideoProviderHooks,
    attempt: number,
) => Promise<boolean>;

const REFERENCE_QUERY_BOILERPLATE = new Set([
    'art', 'artwork', 'appearance', 'character', 'characters', 'concept', 'design', 'face',
    'film', 'full', 'game', 'high', 'identity', 'image', 'images', 'look', 'movie', 'official',
    'photo', 'photos', 'picture', 'pictures', 'portrait', 'promotional', 'publicity', 'reference',
    'references', 'resolution', 'screenshot', 'series', 'show', 'still', 'style', 'tv', 'visual',
]);
const GENERIC_IDENTITY_LABEL_WORDS = new Set([
    'alien', 'animal', 'avocado', 'baby', 'boy', 'cat', 'character', 'child', 'creature',
    'dog', 'driver', 'girl', 'hero', 'human', 'identity', 'man', 'monster', 'person', 'people',
    'protagonist', 'racer', 'reference', 'robot', 'subject', 'villain', 'woman', 'worker',
]);
const DEFERRED_IDENTITY_REFERENCE_TITLE = /\b(?:painting|painted|artwork|illustration|illustrated|drawing|sketch|cross[- ]?stitch(?:ed)?|wood print|art print|wall art|poster|merchandise|figurine|statue|action figure|t[- ]?shirt)\b/i;
const DEFERRED_IDENTITY_REFERENCE_HOST = /(?:^|\.)(?:etsy|fineartamerica|redbubble|teepublic|society6|ebay)\.[a-z.]+$/i;

function transientReferenceSearchFailure(error: unknown): boolean {
    return /timed out|timeout|aborted|fetch|network|socket|econn|HTTP (408|409|429|5\d\d)/i.test(
        error instanceof Error ? error.message : String(error),
    );
}

function boundedText(value: unknown, maximum: number): string {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function referenceWords(value: string): string[] {
    return [...new Set(value.toLocaleLowerCase().match(/[a-z0-9]+/g) || [])];
}

function isGenericIdentityRequirement(requirement: VideoKeyframeReferenceRequirement): boolean {
    if (requirement.kind !== 'identity' && requirement.kind !== 'character') return false;
    const labelWords = referenceWords(requirement.label)
        .filter(word => !REFERENCE_QUERY_BOILERPLATE.has(word));
    return labelWords.length > 0
        && labelWords.every(word => GENERIC_IDENTITY_LABEL_WORDS.has(word));
}

function needsAmbiguousIdentityValidation(requirement: VideoKeyframeReferenceRequirement): boolean {
    if (requirement.kind !== 'identity' && requirement.kind !== 'character') return false;
    const distinctiveWords = referenceWords(requirement.searchQuery)
        .filter(word => word.length > 1 && !REFERENCE_QUERY_BOILERPLATE.has(word));
    return distinctiveWords.length < 2;
}

function orderedReferenceResults(
    requirement: VideoKeyframeReferenceRequirement,
    results: ImageSearchResult[],
    environment: NodeJS.ProcessEnv = process.env,
): ImageSearchResult[] {
    if ((requirement.kind !== 'identity' && requirement.kind !== 'character')
        || environment.VIDEO_IDENTITY_REFERENCE_METADATA_RANKING === '0') return results;
    const preferred: ImageSearchResult[] = [];
    const deferred: ImageSearchResult[] = [];
    for (const result of results) {
        const host = boundedText(result.displayLink, 200).replace(/^www\./i, '');
        if (DEFERRED_IDENTITY_REFERENCE_TITLE.test(boundedText(result.title, 200))
            || DEFERRED_IDENTITY_REFERENCE_HOST.test(host)) {
            deferred.push(result);
        } else {
            preferred.push(result);
        }
    }
    return [...preferred, ...deferred];
}

function referenceRequirements(plan: Record<string, any>): VideoKeyframeReferenceRequirement[] {
    const kinds = new Set<VideoKeyframeReferenceKind>(['identity', 'character', 'object', 'location', 'style']);
    const raw = Array.isArray(plan?.keyframe?.reference_requirements)
        ? plan.keyframe.reference_requirements
        : [];
    const requirements: VideoKeyframeReferenceRequirement[] = [];
    for (const candidate of raw.slice(0, VIDEO_KEYFRAME_MAX_REFERENCES)) {
        const label = boundedText(candidate?.label, 80);
        const searchQuery = boundedText(candidate?.search_query, 160);
        const visualFactsToPreserve = boundedText(candidate?.visual_facts_to_preserve, 400);
        const kind = boundedText(candidate?.kind, 20) as VideoKeyframeReferenceKind;
        if (!label || !searchQuery || !visualFactsToPreserve || !kinds.has(kind)) continue;
        const requirement = { label, kind, searchQuery, visualFactsToPreserve };
        if (!isGenericIdentityRequirement(requirement)) requirements.push(requirement);
    }
    return requirements;
}

async function validateAmbiguousVideoKeyframeReference(
    requirement: VideoKeyframeReferenceRequirement,
    result: ImageSearchResult,
    image: DownloadedImage,
    hooks: VideoProviderHooks,
    attempt: number,
): Promise<boolean> {
    const started = Date.now();
    let outcome: 'accepted' | 'rejected' | 'error' = 'error';
    let detail: string | undefined;
    try {
        const mimeType = mimeTypeForExtension(image.extension);
        const client = new GoogleGenAI({ apiKey: config.geminiApiKey, apiVersion: 'v1alpha' });
        const response = await client.models.generateContent({
            model: VIDEO_KEYFRAME_REFERENCE_VALIDATION_MODEL,
            contents: [{
                role: 'user',
                parts: [
                    {
                        text: [
                            `Target label: ${requirement.label}`,
                            `Public image search query: ${requirement.searchQuery}`,
                            `Declared visual facts to preserve: ${requirement.visualFactsToPreserve}`,
                            `Search-result title: ${boundedText(result.title, 200)}`,
                            `Search-result source: ${boundedText(result.displayLink, 200)}`,
                            '',
                            'Decide whether the candidate visibly and specifically depicts the intended target well enough to bind a generated video\'s identity or character design.',
                            'Reject unrelated results, wordplay, text/logo merchandise that does not clearly show the target, generic inspiration, and ambiguous results that cannot establish the intended identity.',
                            'A product photo qualifies only when it clearly shows the correct named character\'s canonical design.',
                        ].join('\n'),
                    },
                    { text: 'CANDIDATE REFERENCE:' },
                    { inlineData: { mimeType, data: image.data.toString('base64') } },
                ],
            }],
            config: {
                systemInstruction: 'You are a conservative visual-reference relevance gate. False acceptance is worse than omitting a questionable reference. Output JSON.',
                responseMimeType: 'application/json',
                responseJsonSchema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['usable'],
                    properties: { usable: { type: 'boolean' } },
                },
                thinkingConfig: { thinkingLevel: 'MINIMAL' as any },
                temperature: 0,
                maxOutputTokens: 100,
            },
        });
        const parsed = JSON.parse(response.text || '{}');
        if (typeof parsed?.usable !== 'boolean') {
            throw new Error('Reference relevance gate returned invalid structured output.');
        }
        outcome = parsed.usable ? 'accepted' : 'rejected';
        if (!parsed.usable) detail = 'Ambiguous public reference did not establish the declared target.';
        const usage = response.usageMetadata;
        await hooks.onUsage?.({
            stage: 'keyframe_reference_validation',
            attempt,
            outcome,
            provider: 'google',
            model: VIDEO_KEYFRAME_REFERENCE_VALIDATION_MODEL,
            serviceTier: 'default',
            inputTokens: Number(usage?.promptTokenCount || 0),
            outputTokens: Number(usage?.candidatesTokenCount || 0),
        });
        return parsed.usable;
    } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
        throw error;
    } finally {
        await hooks.onAttempt?.({
            stage: 'keyframe_reference_validation',
            attempt,
            outcome,
            provider: 'google',
            model: VIDEO_KEYFRAME_REFERENCE_VALIDATION_MODEL,
            serviceTier: 'default',
            durationSeconds: (Date.now() - started) / 1000,
            detail,
        });
    }
}

function mimeTypeForExtension(extension: string): VideoKeyframeReference['mimeType'] {
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'webp') return 'image/webp';
    return 'image/png';
}

function extensionForMimeType(mimeType: VideoKeyframeReference['mimeType']): string {
    if (mimeType === 'image/jpeg') return 'jpg';
    if (mimeType === 'image/webp') return 'webp';
    return 'png';
}

function requirementsDigest(requirements: VideoKeyframeReferenceRequirement[]): string {
    return createHash('sha256').update(JSON.stringify(requirements)).digest('hex');
}

function cachedReferences(directory: string, digest: string): VideoKeyframeReference[] | null {
    const manifestPath = join(directory, 'manifest.json');
    if (!existsSync(manifestPath)) return null;
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReferenceManifest;
        if (manifest?.version !== 1 || manifest.requirements_sha256 !== digest
            || !Array.isArray(manifest.references)) return null;
        return manifest.references.map((entry) => {
            if (!/^reference_[1-4]\.(jpg|png|webp)$/.test(entry.filename)) {
                throw new Error('Invalid cached reference filename.');
            }
            const mimeType = mimeTypeForExtension(entry.filename.split('.').pop() || '');
            const bytes = readFileSync(join(directory, entry.filename));
            if (!bytes.length) throw new Error('Empty cached reference image.');
            return {
                label: boundedText(entry.label, 80),
                kind: entry.kind,
                visualFactsToPreserve: boundedText(entry.visual_facts_to_preserve, 400),
                bytes,
                mimeType,
                sourceUrl: boundedText(entry.source_url, 2048),
                contextUrl: boundedText(entry.context_url, 2048),
            };
        });
    } catch {
        return null;
    }
}

export async function searchVideoKeyframeReferenceImages(
    query: string,
    fetchSearch: typeof fetch = fetch,
): Promise<ImageSearchResult[]> {
    const params = new URLSearchParams({
        key: config.googleApiKey,
        cx: config.googleSearchEngineId,
        q: boundedText(query, 160),
        searchType: 'image',
        num: '8',
        safe: 'off',
        lr: 'lang_en',
        gl: 'us',
        imgSize: 'large',
    });
    const response = await fetchSearch(`https://www.googleapis.com/customsearch/v1?${params.toString()}`);
    const body: any = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(body?.error?.message || `Google image search returned HTTP ${response.status}.`);
    }
    return (Array.isArray(body?.items) ? body.items : [])
        .filter(isUsableImageResult)
        .map((item: any) => ({
            title: boundedText(item.title, 200),
            link: item.link,
            url: item.image?.contextLink || item.link,
            displayLink: boundedText(item.displayLink, 200),
            thumbnailLink: item.image.thumbnailLink,
            byteSize: Number(item.image.byteSize) || undefined,
        }));
}

export async function resolveVideoKeyframeReferences(
    plan: Record<string, any>,
    jobDirectory: string,
    searchImages: SearchImages = searchVideoKeyframeReferenceImages,
    downloadImage: DownloadImage = downloadSearchResultImage,
    hooks: VideoProviderHooks = {},
    validateReference: ValidateReference = validateAmbiguousVideoKeyframeReference,
): Promise<VideoKeyframeReference[]> {
    if (plan?.keyframe?.recommended !== true) return [];
    const requirements = referenceRequirements(plan);
    if (!requirements.length) return [];

    const directory = join(jobDirectory, 'references');
    const digest = requirementsDigest(requirements);
    const cached = cachedReferences(directory, digest);
    if (cached) return cached;

    mkdirSync(directory, { recursive: true });
    const references: VideoKeyframeReference[] = [];
    const manifestReferences: CachedReference[] = [];
    const resolved = await Promise.all(requirements.map(async (requirement, requirementIndex) => {
        try {
            let results: ImageSearchResult[] | null = null;
            let lastSearchError: unknown;
            for (let retry = 0; retry < 2; retry += 1) {
                const searchStarted = Date.now();
                let searchOutcome: 'success' | 'error' = 'error';
                let searchDetail: string | undefined;
                const attempt = requirementIndex * 2 + retry + 1;
                try {
                    results = await searchImages(requirement.searchQuery);
                    searchOutcome = 'success';
                } catch (error) {
                    lastSearchError = error;
                    searchDetail = error instanceof Error ? error.message : String(error);
                } finally {
                    await hooks.onUsage?.({
                        stage: 'keyframe_reference_search',
                        attempt,
                        outcome: searchOutcome,
                        provider: 'google',
                        model: 'google-custom-search',
                        serviceTier: 'default',
                        webSearches: 1,
                        costOverride: 0.005,
                    });
                    await hooks.onAttempt?.({
                        stage: 'keyframe_reference_search',
                        attempt,
                        outcome: searchOutcome,
                        provider: 'google',
                        model: 'google-custom-search',
                        serviceTier: 'default',
                        durationSeconds: (Date.now() - searchStarted) / 1000,
                        detail: searchDetail,
                    });
                }
                if (results) break;
                if (!transientReferenceSearchFailure(lastSearchError)) break;
            }
            if (!results) throw lastSearchError || new Error('Reference search failed.');
            let selected: { result: ImageSearchResult; image: Awaited<ReturnType<DownloadImage>> } | null = null;
            for (const result of orderedReferenceResults(requirement, results.slice(0, 5))) {
                const image = await downloadImage(result);
                if (image && ['jpg', 'jpeg', 'png', 'webp'].includes(image.extension)) {
                    if (needsAmbiguousIdentityValidation(requirement)) {
                        const valid = await validateReference(
                            requirement,
                            result,
                            image,
                            hooks,
                            requirementIndex + 1,
                        );
                        if (!valid) continue;
                    }
                    selected = { result, image };
                    break;
                }
            }
            if (!selected?.image) {
                console.warn(`No usable first-frame reference image found for ${requirement.label}.`);
                return null;
            }
            return { requirement, selected };
        } catch (error) {
            if (error instanceof VideoUsagePersistenceError) throw error;
            console.warn(`Could not retrieve first-frame reference for ${requirement.label}.`, error);
            return null;
        }
    }));
    for (const match of resolved) {
        if (!match) continue;
        const { requirement, selected } = match;
        const downloaded = selected.image;
        if (!downloaded) continue;
        try {
            const mimeType = mimeTypeForExtension(downloaded.extension);
            const filename = `reference_${references.length + 1}.${extensionForMimeType(mimeType)}`;
            writeFileSync(join(directory, filename), downloaded.data);
            references.push({
                label: requirement.label,
                kind: requirement.kind,
                visualFactsToPreserve: requirement.visualFactsToPreserve,
                bytes: downloaded.data,
                mimeType,
                sourceUrl: selected.result.link,
                contextUrl: selected.result.url,
            });
            manifestReferences.push({
                label: requirement.label,
                kind: requirement.kind,
                visual_facts_to_preserve: requirement.visualFactsToPreserve,
                source_url: selected.result.link,
                context_url: selected.result.url,
                filename,
            });
        } catch (error) {
            console.warn(`Could not cache first-frame reference for ${requirement.label}.`, error);
        }
    }
    const manifest: ReferenceManifest = {
        version: 1,
        requirements_sha256: digest,
        references: manifestReferences,
    };
    writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return references;
}

export function countVideoKeyframeReferenceRequirements(plan: Record<string, any>): number {
    return referenceRequirements(plan).length;
}
