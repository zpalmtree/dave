import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptUrl = new URL('../scripts/deploy-bots.sh', import.meta.url);
const script = readFileSync(scriptUrl, 'utf8');

test('broker deployment advertises active-render preservation', () => {
    const help = spawnSync('bash', [scriptUrl.pathname, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /preserve an active render/);
});

test('broker deployment restarts before waiting for lease reconciliation', () => {
    const main = script.slice(script.indexOf('\nload_node\n'));
    const pauseIndex = main.indexOf('    pause_video_dispatch');
    const deployIndex = main.indexOf('deploy_repo "$REMOTE_MASTER_DIR" master');
    const restartIndex = main.indexOf('    restart_video_broker');
    const recoveryIndex = main.indexOf('    wait_for_video_broker_recovery');
    const resumeIndex = main.indexOf('resume_video_dispatch\npm2 save');

    assert.ok(pauseIndex >= 0);
    assert.ok(pauseIndex < deployIndex);
    assert.ok(deployIndex < restartIndex);
    assert.ok(restartIndex < recoveryIndex);
    assert.ok(recoveryIndex < resumeIndex);
    assert.doesNotMatch(script, /waiting for active rendering and preparation to finish/);
    assert.match(script, /state\.current_job === expectedJob/);
});
