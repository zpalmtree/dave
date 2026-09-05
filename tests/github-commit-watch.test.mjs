import test from 'node:test';
import assert from 'node:assert/strict';
import { planUpdates as planEmbeds, notificationOptions, deliverPending, listBranches } from '../dist/GitHubCommitWatch.js';
// Existing detection checks inspect individual sections inside the grouped embeds.
async function planUpdates(...args) {
    const result = await planEmbeds(...args);
    return { ...result, pending: result.pending.flatMap(item => typeof item === 'string' ? [item] : item.embeds.flatMap(embed => embed.description.split('\n\n'))) };
}
const repo = 'Xazware/Pooners';
const thread = '1544486384629452831';
const branch = (name, sha) => ({ name, commit: { sha } });
const commit = sha => ({ sha, commit: { message: 'Fix bug\nDetails', author: { name: 'Dev' } } });
const state = heads => ({ repository: repo, threadId: thread, heads, pending: [] });
test('baseline includes all branches without historical posts', async () => {
    const result = await planUpdates(undefined, repo, thread, async () => [branch('main', 'a'), branch('feature', 'b')]);
    assert.deepEqual(result.heads, { main: 'a', feature: 'b' });
    assert.deepEqual(result.pending, []);
});
test('unchanged branches do not fetch commits', async () => {
    const result = await planUpdates(state({ main: 'a' }), repo, thread, async path => {
        if (path.includes('/pulls?')) return [];
        assert.match(path, /^\/branches/); return [branch('main', 'a')];
    });
    assert.deepEqual(result.pending, []);
});
test('fetches every compare page and tracks main and feature branches', async () => {
    const result = await planUpdates(state({ main: 'a', feature: 'b' }), repo, thread, async path => {
        if (path.includes('/pulls?')) return [];
        if (path.startsWith('/branches')) return [branch('main', 'c'), branch('feature', 'd')];
        if (path.includes('a...c') && path.endsWith('page=1')) return { status: 'ahead', commits: Array.from({ length: 100 }, (_, i) => commit(`sha${i}`)) };
        return { status: 'ahead', commits: [commit(path.includes('a...c') ? 'last' : 'feature')] };
    });
    assert.equal(result.pending.length, 102);
    assert.match(result.pending[100], /last/);
    assert.match(result.pending[101], /feature/);
});
test('new branches announce creation and compare against default branch', async () => {
    const result = await planUpdates(state({ main: 'a' }), repo, thread, async path => {
        if (path.includes('/pulls?')) return [];
        if (path.startsWith('/branches')) return [branch('main', 'a'), branch('topic/x', 'b')];
        if (!path) return { default_branch: 'main' };
        assert.match(path, /a\.\.\.b/);
        return { status: 'ahead', commits: [commit('b')] };
    });
    assert.equal(result.pending.length, 2);
    assert.match(result.pending[0], /New branch/);
});
test('deleted branches are removed and missing old SHAs are reported', async () => {
    const result = await planUpdates(state({ main: 'a', deleted: 'b' }), repo, thread, async path => {
        if (path.includes('/pulls?')) return [];
        if (path.startsWith('/branches')) return [branch('main', 'c')];
        if (path.startsWith('/compare')) throw Object.assign(new Error('missing'), { status: 404 });
        return commit('c');
    });
    assert.deepEqual(result.heads, { main: 'c' });
    assert.match(result.pending[0], /history rewritten/);
});
test('API failure leaves previous cursor untouched', async () => {
    const before = state({ main: 'a' });
    await assert.rejects(planUpdates(before, repo, thread, async path => {
        if (path.includes('/pulls?')) return [];
        if (path.startsWith('/branches')) return [branch('main', 'b')];
        throw new Error('rate limited');
    }), /rate limited/);
    assert.deepEqual(before.heads, { main: 'a' });
});
test('delivery failure preserves unsent messages, successful messages checkpoint individually', async () => {
    const pending = { ...state({ main: 'b' }), pending: ['one', 'two'] };
    const saved = [];
    await assert.rejects(deliverPending(pending, async content => {
        if (content === 'two') throw new Error('Discord unavailable');
    }, async () => saved.push([...pending.pending])), /Discord unavailable/);
    assert.deepEqual(saved, [['two']]);
    assert.deepEqual(pending.pending, ['two']);
});
test('branch listing paginates', async () => {
    const result = await listBranches(async path => path.endsWith('page=1') ? Array.from({ length: 100 }, (_, i) => branch(`${i}`, 'a')) : [branch('last', 'z')]);
    assert.equal(result.length, 101);
});
test('destination changes fail closed', async () => {
    await assert.rejects(planUpdates(state({}), repo, 'other', async () => []), /destination/);
});

const pr = { number: 4, merged_at: '2026-09-05T00:00:00Z', merge_commit_sha: 'merge', head: { ref: 'codex/title-harpoon-transition' }, base: { ref: 'main' } };
async function mergedUpdate({ parents = 2, pulls = [pr], subject = 'Custom title', pullError, detailError, destination = 'main' } = {}) {
    const merged = { ...commit('merge'), parents: Array.from({ length: parents }, () => ({ sha: 'parent' })), committer: { login: 'git-committer' } };
    merged.commit.message = subject;
    return planUpdates(state({ [destination]: 'old' }), repo, thread, async path => {
        if (path.startsWith('/branches')) return [branch(destination, 'merge')];
        if (path.startsWith('/compare')) return { status: 'ahead', commits: [merged] };
        if (path.includes('/pulls?')) {
            if (pullError) throw Object.assign(new Error('PR lookup failed'), { status: pullError });
            return pulls;
        }
        assert.equal(path, '/pulls/4');
        if (detailError) throw new Error('PR detail unavailable');
        return { ...pr, merged_by: { login: 'xaz' } };
    });
}
test('PR merges highlight actual merger, source, destination and link despite custom subject', async () => {
    const result = await mergedUpdate();
    assert.match(result.pending[0], /🔀 \*\*xaz merged branch codex\/title-harpoon-transition into main\*\*/);
    assert.match(result.pending[0], /PR #4/);
    assert.match(result.pending.join('\n'), /Custom title/);
    assert.doesNotMatch(result.pending[0], /git-committer merged/);
});
test('single-parent squash and rebase results receive PR merge highlights', async () => {
    const result = await mergedUpdate({ parents: 1 });
    assert.match(result.pending[0], /xaz merged branch/);
});
test('associated open PRs and non-merge commits are not labeled as merges', async () => {
    for (const pulls of [[{ ...pr, merged_at: null }], [{ ...pr, merge_commit_sha: 'other' }]]) {
        const result = await mergedUpdate({ parents: 1, pulls });
        assert.doesNotMatch(result.pending[0], /🔀/);
    }
});
test('older PR merges inherited by another branch are only labeled merge commits', async () => {
    const result = await mergedUpdate({ destination: 'release' });
    assert.match(result.pending[0], /Merge commit/);
    assert.doesNotMatch(result.pending[0], /merged branch/);
});
test('direct Git merges label branch and committer without a PR', async () => {
    const result = await mergedUpdate({ pulls: [], subject: "Merge branch 'topic' into main" });
    assert.match(result.pending[0], /git-committer merged branch topic into main/);
});
test('merge subjects do not invent an unspecified destination', async () => {
    const result = await mergedUpdate({ pulls: [], subject: "Merge branch 'topic'" });
    assert.match(result.pending[0], /merged branch topic/);
    assert.doesNotMatch(result.pending[0], /into main/);
});
test('missing PR access retains generic merge labeling and commit delivery', async () => {
    const result = await mergedUpdate({ pullError: 403 });
    assert.match(result.pending[0], /Merge commit/);
});
test('transient PR lookup and detail failures retry before advancing the cursor', async () => {
    await assert.rejects(mergedUpdate({ pullError: 500 }), /PR lookup failed/);
    await assert.rejects(mergedUpdate({ detailError: true }), /PR detail unavailable/);
});
test('long commit summaries plus merge metadata fit Discord message limits', async () => {
    const result = await mergedUpdate({ subject: '*'.repeat(1000) });
    assert.ok(result.pending[0].length <= 2000);
    assert.match(result.pending[0], /xaz merged branch/);
});

async function integration({ oldHeads = { main: 'a', topic: 'c' }, branches = [branch('main', 'c'), branch('topic', 'c')], status = 'ahead', commits = [commit('b'), commit('c')] } = {}) {
    return planEmbeds(state(oldHeads), repo, thread, async path => {
        if (path.startsWith('/branches')) return branches;
        if (path.includes('/pulls?')) return [];
        if (path.startsWith('/compare')) return { status, commits };
        if (!path) return { default_branch: 'main' };
        throw new Error(`Unexpected request ${path}`);
    });
}
test('fast-forward integration is highlighted in one purple embed with all commits', async () => {
    const result = await integration();
    assert.equal(result.pending.length, 1);
    const embed = result.pending[0].embeds[0];
    assert.equal(embed.color, 0x8957e5);
    assert.match(embed.description, /topic → main/);
    assert.match(embed.description, /commit\/b/);
    assert.match(embed.description, /commit\/c/);
    assert.match(embed.footer.text, /inferred.*merger unknown/);
    assert.match(embed.url, /compare\/a\.\.\.c/);
});
test('integration still works after deleting or advancing the source branch', async () => {
    for (const branches of [[branch('main', 'c')], [branch('main', 'c'), branch('topic', 'd')]]) {
        const result = await integration({ branches });
        assert.match(result.pending[0].embeds[0].description, /topic → main/);
    }
});
test('ordinary pushes and rewritten history do not imply branch integrations', async () => {
    for (const options of [{ oldHeads: { main: 'a' } }, { status: 'diverged' }]) {
        const result = await integration(options);
        assert.doesNotMatch(result.pending[0].embeds[0].description, /Branch integration/);
        assert.equal(result.pending[0].embeds[0].color, 0x2f81f7);
    }
});
test('new refs sharing the new destination tip are not mistaken for source branches', async () => {
    const result = await integration({ oldHeads: { main: 'a' } });
    assert.doesNotMatch(result.pending[0].embeds[0].description, /integration/);
});
test('large batches paginate embeds without dropping commits or exceeding Discord limits', async () => {
    const commits = Array.from({ length: 80 }, (_, i) => ({ ...commit(`sha${i}`), commit: { message: '*'.repeat(1000), author: { name: 'Author' } } }));
    const result = await integration({ oldHeads: { main: 'a' }, branches: [branch('main', 'z')], commits });
    const text = result.pending.map(item => item.embeds[0].description).join('\n');
    for (const c of commits) assert.ok(text.includes(`/commit/${c.sha})`));
    for (const item of result.pending) {
        const embed = item.embeds[0];
        assert.ok(embed.description.length <= 4096);
        assert.ok(embed.title.length <= 256);
        assert.ok(embed.description.length + embed.title.length + embed.author.name.length + embed.footer.text.length <= 6000);
    }
});
test('legacy text outbox entries and new embed entries both deliver with mentions disabled', async () => {
    assert.deepEqual(notificationOptions('old pending message'), { content: 'old pending message', allowedMentions: { parse: [] } });
    const result = await integration();
    assert.deepEqual(notificationOptions(result.pending[0]).allowedMentions, { parse: [] });
    const queued = { ...state({}), pending: ['legacy', result.pending[0]] };
    const sent = [];
    await deliverPending(queued, async item => sent.push(notificationOptions(item)), async () => {});
    assert.equal(sent[0].content, 'legacy');
    assert.ok(sent[1].embeds.length);
    assert.equal(queued.pending.length, 0);
});
test('a subsequent merge in the same poll does not hide the earlier branch integration', async () => {
    const merged = { ...commit('d'), parents: [{ sha: 'c' }, { sha: 'other' }] };
    const result = await integration({ branches: [branch('main', 'd'), branch('topic', 'c')], commits: [commit('b'), commit('c'), merged] });
    assert.match(result.pending[0].embeds[0].description, /topic → main/);
    assert.match(result.pending[0].embeds[0].footer.text, /Integration inferred/);
});
