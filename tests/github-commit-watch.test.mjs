import test from 'node:test';
import assert from 'node:assert/strict';
import { planUpdates, deliverPending, listBranches } from '../dist/GitHubCommitWatch.js';
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
        assert.match(path, /^\/branches/); return [branch('main', 'a')];
    });
    assert.deepEqual(result.pending, []);
});
test('fetches every compare page and tracks main and feature branches', async () => {
    const result = await planUpdates(state({ main: 'a', feature: 'b' }), repo, thread, async path => {
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
