import { Client, escapeMarkdown } from 'discord.js';
import fetch from 'node-fetch';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

interface Branch { name: string; commit: { sha: string } }
interface Commit { sha: string; commit: { message: string; author: { name: string } | null } }
interface Settings { token: string; botUserId: string; repository: string; threadId: string }
export interface WatchState {
    repository: string;
    threadId: string;
    heads: Record<string, string>;
    pending: string[];
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

export async function planUpdates(state: WatchState | undefined, repository: string, threadId: string, request: Request): Promise<WatchState> {
    const branches = await listBranches(request);
    const heads = Object.fromEntries(branches.map(branch => [branch.name, branch.commit.sha]));
    if (!state) return { repository, threadId, heads, pending: [] };
    if (state.repository !== repository || state.threadId !== threadId) throw new Error('Watch state destination differs from configuration. Use a new state file.');
    if (state.pending.length) throw new Error('Deliver pending messages before polling.');
    const pending: string[] = [];
    let defaultBranch: string | undefined;
    for (const branch of branches) {
        const previous = state.heads[branch.name];
        const head = branch.commit.sha;
        if (previous === head) continue;
        let base = previous;
        if (!base) {
            defaultBranch ??= (await request('')).default_branch;
            base = state.heads[defaultBranch!] || heads[defaultBranch!];
        }
        const prefix = `**${plain(repository, 150)} · ${plain(branch.name, 180)}**`;
        const commits: Commit[] = [];
        let rewritten = false;
        if (base && base !== head) {
            try {
                for (let page = 1; ; page++) {
                    const comparison = await request(`/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100&page=${page}`);
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
        if (!previous || rewritten || !commits.length) {
            pending.push(`${prefix}\n${!previous ? 'New branch' : rewritten ? 'Branch history rewritten' : 'Branch updated'}: [${head.slice(0, 7)}](https://github.com/${repository}/commit/${head})`);
        }
        for (const commit of commits) {
            pending.push(`${prefix}\n[${commit.sha.slice(0, 7)}](https://github.com/${repository}/commit/${commit.sha}) ${plain(commit.commit.message.split('\n')[0], 1000)} — ${plain(commit.commit.author?.name || 'Unknown author', 150)}`);
        }
    }
    return { repository, threadId, heads, pending };
}

export async function saveState(path: string, state: WatchState): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(`${path}.tmp`, path);
}

export async function deliverPending(state: WatchState, send: (content: string) => Promise<unknown>, save: () => Promise<void>): Promise<void> {
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
                const send = async (content: string) => {
                    if (channel.archived) await channel.setArchived(false);
                    return channel.send({ content, allowedMentions: { parse: [] } });
                };
                if (state) await deliverPending(state, send, () => saveState(statePath, state!));
                const initialized = Boolean(state);
                state = await planUpdates(state, repository, threadId, request);
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
