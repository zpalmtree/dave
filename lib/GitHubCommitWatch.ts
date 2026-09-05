import { APIEmbed, Client, escapeMarkdown, MessageCreateOptions } from 'discord.js';
import fetch from 'node-fetch';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

interface Branch { name: string; commit: { sha: string } }
interface Commit {
    sha: string;
    parents?: { sha: string }[];
    author?: { login: string; avatar_url: string } | null;
    committer?: { login: string } | null;
    commit: { message: string; author: { name: string } | null; committer?: { name: string } | null };
}
interface PullRequest {
    number: number;
    merged_at: string | null;
    merge_commit_sha: string | null;
    merged_by?: { login: string } | null;
    head: { ref: string };
    base: { ref: string };
}
interface Settings { token: string; botUserId: string; repository: string; threadId: string }
export interface WatchState {
    repository: string;
    threadId: string;
    heads: Record<string, string>;
    lastPullRequestNumber?: number;
    pending: WatchNotification[];
}
export type WatchNotification = string | { embeds: APIEmbed[] };

export function notificationOptions(notification: WatchNotification): MessageCreateOptions {
    return { ...(typeof notification === 'string' ? { content: notification } : notification), allowedMentions: { parse: [] } };
}

type Request = (path: string) => Promise<any>;

export async function listBranches(request: Request): Promise<Branch[]> {
    const branches: Branch[] = [];
    for (let page = 1; ; page++) {
        const batch = await request(`/branches?per_page=100&page=${page}`);
        branches.push(...batch);
        if (batch.length < 100) return branches;
    }
}

const plain = (value: string, limit: number) => escapeMarkdown(value.replace(/[\r\n]+/g, ' ').slice(0, limit));

// Resolve PR metadata once per SHA per poll, even when it appears on several branches.
function mergeFormatter(repository: string, request: Request) {
    const cache = new Map<string, PullRequest[]>();
    let pullAccess = true;
    return async (commit: Commit, destination: string): Promise<string | undefined> => {
        let pulls = cache.get(commit.sha);
        if (!pulls && pullAccess) {
            pulls = [];
            try {
                for (let page = 1; ; page++) {
                    const batch: PullRequest[] = await request(`/commits/${encodeURIComponent(commit.sha)}/pulls?per_page=100&page=${page}`);
                    pulls.push(...batch);
                    if (batch.length < 100) break;
                }
                cache.set(commit.sha, pulls);
            } catch (error) {
                // Missing PR permission must not disable ordinary commit tracking.
                if (![403, 404].includes((error as { status?: number }).status || 0)) throw error;
                pullAccess = false;
                console.warn('[GitHub watch] PR metadata unavailable; using merge-commit labels. Token needs Pull requests: read.');
            }
        }
        const pull = pulls?.find(pr => pr.merged_at && pr.merge_commit_sha === commit.sha && pr.base.ref === destination);
        if (pull) {
            const detail: PullRequest = await request(`/pulls/${pull.number}`);
            const actor = detail.merged_by?.login;
            const action = actor ? `${plain(actor, 100)} merged branch` : 'Merged branch';
            return `🔀 **${action} ${plain(pull.head.ref, 180)} into ${plain(pull.base.ref, 180)}**\n[PR #${pull.number}](https://github.com/${repository}/pull/${pull.number})`;
        }
        if ((commit.parents?.length || 0) < 2) return undefined;
        // An older PR merge carried into another branch is not a new PR merge there.
        if (pulls?.some(pr => pr.merged_at && pr.merge_commit_sha === commit.sha)) return '🔀 **Merge commit**';
        const subject = commit.commit.message.split('\n')[0];
        const local = /^Merge (?:remote-tracking )?branch '([^']+)'(?: into (.+))?$/.exec(subject);
        if (local) {
            const actor = commit.committer?.login || commit.commit.committer?.name;
            // Without an explicit target, Git's subject cannot prove the original destination.
            const target = local[2] ? ` into ${plain(local[2], 180)}` : '';
            return `🔀 **${actor ? `${plain(actor, 100)} merged branch` : 'Merged branch'} ${plain(local[1], 180)}${target}**`;
        }
        return '🔀 **Merge commit**';
    };
}

export async function planUpdates(state: WatchState | undefined, repository: string, threadId: string, request: Request): Promise<WatchState> {
    const branches = await listBranches(request);
    const heads = Object.fromEntries(branches.map(branch => [branch.name, branch.commit.sha]));
    if (!state) return { repository, threadId, heads, pending: [] };
    if (state.repository !== repository || state.threadId !== threadId) throw new Error('Watch state destination differs from configuration. Use a new state file.');
    if (state.pending.length) throw new Error('Deliver pending messages before polling.');
    const pending: WatchNotification[] = [];
    let defaultBranch: string | undefined;
    const formatMerge = mergeFormatter(repository, request);
    for (const branch of branches) {
        const previous = state.heads[branch.name];
        const head = branch.commit.sha;
        if (previous === head) continue;
        let base = previous;
        if (!base) {
            defaultBranch ??= (await request('')).default_branch;
            base = state.heads[defaultBranch!] || heads[defaultBranch!];
        }
        const entries: string[] = [];
        const mergeLabels: string[] = [];
        const commits: Commit[] = [];
        let rewritten = false;
        let ahead = false;
        if (base && base !== head) {
            try {
                for (let page = 1; ; page++) {
                    const comparison = await request(`/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=${page}`);
                    ahead = comparison.status === 'ahead';
                    rewritten = comparison.status === 'diverged' || comparison.status === 'behind';
                    commits.push(...comparison.commits);
                    if (comparison.commits.length < 100) break;
                }
            } catch (error) {
                if ((error as { status?: number }).status !== 404) throw error;
                rewritten = true;
                commits.push(await request(`/commits/${encodeURIComponent(head)}`));
            }
        }
        if (rewritten || !commits.length) {
            entries.push(`${!previous ? 'Branch tip' : rewritten ? 'Branch history rewritten' : 'Branch updated'}: [${head.slice(0, 7)}](https://github.com/${repository}/commit/${head})`);
        }
        for (const commit of commits) {
            const merge = await formatMerge(commit, branch.name);
            if (merge) mergeLabels.push(merge);
            const content = `[${commit.sha.slice(0, 7)}](https://github.com/${repository}/commit/${commit.sha}) ${plain(commit.commit.message.split('\n')[0], 1000)} — ${plain(commit.commit.author?.name || 'Unknown author', 150)}`;
            entries.push(content.length > 2000 ? `${content.slice(0, 1999)}…` : content);
        }
        // Only pre-existing branch tips provide evidence of integration. Matching newly
        // created refs could just be a branch being created from the destination.
        const added = new Set(commits.map(commit => commit.sha));
        const sources = previous && ahead && !rewritten
            ? Object.entries(state.heads).filter(([name, sha]) => name !== branch.name && added.has(sha)).map(([name]) => name)
            : [];
        if (sources.length) {
            for (const source of sources) {
                if (mergeLabels.some(label => label.includes(plain(source, 180)))) continue;
                mergeLabels.push(`**Branch [${plain(source, 180)}](https://github.com/${repository}/tree/${encodeURIComponent(source)}) merged into ${plain(branch.name, 180)}**`);
            }
            if (mergeLabels.length > 1) {
                const generic = mergeLabels.indexOf('🔀 **Merge commit**');
                if (generic !== -1) mergeLabels.splice(generic, 1);
            }
        }
        const title = `${previous ? 'Commits ·' : 'New branch:'} ${branch.name}`.slice(0, 256);
        const sections = [...mergeLabels.map((label, index) => index === mergeLabels.length - 1 ? `${label}\n` : label), ...entries];
        const pages: string[] = [];
        let description = '';
        for (const section of sections) {
            // Each individual section is bounded too (e.g. hundreds of matching refs).
            for (let offset = 0; offset < section.length; offset += 3800) {
                const part = section.slice(offset, offset + 3800);
                if (description && description.length + part.length + 1 > 3800) {
                    pages.push(description);
                    description = '';
                }
                description += `${description ? '\n' : ''}${part}`;
            }
        }
        if (description) pages.push(description);
        const author = commits[0]?.author;
        const avatar = author && /^https:\/\/avatars\.githubusercontent\.com\//.test(author.avatar_url)
            && commits.every(commit => commit.author?.login === author.login)
            ? author.avatar_url : undefined;
        for (const description of pages) {
            pending.push({ embeds: [{
                ...(previous && mergeLabels.length ? {} : { title }),
                url: previous ? `https://github.com/${repository}/compare/${previous}...${head}` : `https://github.com/${repository}/tree/${encodeURIComponent(branch.name)}`,
                ...(avatar ? { thumbnail: { url: avatar } } : {}),
                color: mergeLabels.length ? 0x8957e5 : 0x2f81f7,
                description,
            }] });
        }
    }
    return { ...state, repository, threadId, heads, pending };
}

interface OpenedPullRequest extends PullRequest {
    title: string;
    state: string;
    draft: boolean;
    user: { login: string; avatar_url: string } | null;
}

export async function planPullRequests(state: WatchState, request: Request): Promise<WatchState> {
    const previous = state.lastPullRequestNumber;
    let latest = previous || 0;
    const discovered: OpenedPullRequest[] = [];
    try {
        for (let page = 1; ; page++) {
            // Include closed PRs so an opening followed by a quick close/merge is still seen.
            const batch: OpenedPullRequest[] = await request(`/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`);
            for (const pull of batch) {
                latest = Math.max(latest, pull.number);
                if (previous !== undefined && pull.number > previous) discovered.push(pull);
            }
            if (previous === undefined || batch.length < 100 || batch.some(pull => pull.number <= previous)) break;
        }
    } catch (error) {
        if (![403, 404].includes((error as { status?: number }).status || 0)) throw error;
        console.warn('[GitHub watch] PR opening notifications unavailable; token needs Pull requests: read.');
        return state;
    }
    const pending = [...state.pending];
    for (const pull of discovered.sort((a, b) => a.number - b.number)) {
        const avatar = pull.user?.avatar_url;
        pending.push({ embeds: [{
            title: `${pull.draft ? 'Draft PR opened' : 'PR opened'} #${pull.number}: ${pull.title}`.slice(0, 256),
            url: `https://github.com/${state.repository}/pull/${pull.number}`,
            color: 0x238636,
            description: `**${plain(pull.user?.login || 'Unknown author', 100)}** opened a pull request\n\n${plain(pull.head.ref, 180)} → ${plain(pull.base.ref, 180)}${pull.state === 'closed' ? `\n${pull.merged_at ? 'Already merged' : 'Already closed'}` : ''}`,
            ...(avatar && /^https:\/\/avatars\.githubusercontent\.com\//.test(avatar) ? { thumbnail: { url: avatar } } : {}),
        }] });
    }
    return { ...state, lastPullRequestNumber: latest, pending };
}

export async function saveState(path: string, state: WatchState): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(`${path}.tmp`, path);
}

export async function deliverPending(state: WatchState, send: (content: WatchNotification) => Promise<unknown>, save: () => Promise<void>): Promise<void> {
    while (state.pending.length) {
        await send(state.pending[0]);
        state.pending.shift();
        await save();
    }
}

const started = new WeakSet<Client>();
export function startGitHubCommitWatch(client: Client): void {
    if (started.has(client)) return;
    started.add(client);
    void initialize().catch(error => console.error('[GitHub watch] Setup failed:', error.message));
    async function initialize() {
        const configPath = process.env.GITHUB_WATCH_CONFIG_FILE || join(homedir(), '.config', 'dave-github-watch.json');
        let settings: Settings;
        try {
            settings = JSON.parse(await fs.readFile(configPath, 'utf8'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        if (settings.botUserId !== client.user?.id) return;
        const { token, repository, threadId } = settings;
        if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+$/.test(threadId)) throw new Error('Invalid GitHub watch configuration.');
        const statePath = `${configPath}.state.json`;
        const request: Request = async path => {
            const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
                timeout: 30000,
            });
            if (!response.ok) throw Object.assign(new Error(`GitHub HTTP ${response.status}; check repository access, token expiry, and rate limits.`), { status: response.status });
            return response.json();
        };
        const poll = async () => {
            try {
                const channel = await client.channels.fetch(threadId);
                if (!channel?.isThread()) throw new Error('Configured destination is not an accessible thread.');
                let state: WatchState | undefined;
                try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                if (state && (state.repository !== repository || state.threadId !== threadId)) throw new Error('Watch state destination differs from configuration.');
                const send = async (content: WatchNotification) => {
                    if (channel.archived) await channel.setArchived(false);
                    return channel.send(notificationOptions(content));
                };
                if (state) await deliverPending(state, send, () => saveState(statePath, state!));
                const initialized = Boolean(state);
                state = await planUpdates(state, repository, threadId, request);
                state = await planPullRequests(state, request);
                await saveState(statePath, state);
                await deliverPending(state, send, () => saveState(statePath, state!));
                if (!initialized) console.log(`[GitHub watch] Baseline saved for ${repository}: ${Object.keys(state.heads).length} branches; thread ${threadId}.`);
            } catch (error) {
                console.error('[GitHub watch]', (error as Error).message);
            } finally {
                setTimeout(() => void poll(), 60000).unref();
            }
        };
        console.log(`[GitHub watch] Tracking ${repository} in thread ${threadId} every 60 seconds.`);
        await poll();
    }
}
