import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import fetch from 'node-fetch';

import { config } from './Config.js';
import { VideoProviderHooks, VideoUsagePersistenceError } from './VideoUsage.js';
import {
    ImageSearchResult,
    downloadSearchResultImage,
    isUsableImageResult,
} from './ImageSearch.js';

export const VIDEO_KEYFRAME_MAX_REFERENCES = 4;

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

function transientReferenceSearchFailure(error: unknown): boolean {
    return /timed out|timeout|aborted|fetch|network|socket|econn|HTTP (408|409|429|5\d\d)/i.test(
        error instanceof Error ? error.message : String(error),
    );
}

function boundedText(value: unknown, maximum: number): string {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
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
        requirements.push({ label, kind, searchQuery, visualFactsToPreserve });
    }
    return requirements;
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
            for (const result of results.slice(0, 5)) {
                const image = await downloadImage(result);
                if (image && ['jpg', 'jpeg', 'png', 'webp'].includes(image.extension)) {
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
