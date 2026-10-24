"""Isolated production worker for a frozen rendered experiment; no Discord connection."""
import asyncio
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LIVE = ROOT.parents[1]
sys.path.insert(0, str(LIVE))
import video_worker as module

config = json.loads((ROOT / 'worker-config.json').read_text())

def verify():
    for name, digest in config['renderer_hashes'].items():
        if hashlib.sha256((LIVE / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError('Frozen renderer changed: ' + name)

verify()
if sys.argv[1:] == ['--validate']:
    print('Frozen renderer verified; no worker or GPU job started.')
    raise SystemExit(0)
module.CONFIG_PATH = ROOT / 'worker-settings.json'
for name, relative in {'JOURNAL_PATH': 'journal.json', 'STATE_PATH': 'state.json',
                      'LOG_DIR': 'logs', 'PLAN_DIR': 'plans', 'KEYFRAME_DIR': 'keyframes',
                      'GPUQ_RESERVATION_DIR': 'gpuq', 'IMAGE_JOB_DIR': 'images'}.items():
    setattr(module, name, ROOT / relative)
    if '.' not in relative:
        (ROOT / relative).mkdir(exist_ok=True)
seed = module.stable_job_seed
module.stable_job_seed = lambda job_id: config['seeds'].get(str(job_id), seed(job_id))

class ExperimentWorker(module.DesktopVideoWorker):
    def start_gpu_monitor(self):
        self.gpu_samples = []

    async def fail_current(self, error, retryable, **kwargs):
        return await super().fail_current(error, False, **kwargs)

    async def run_job(self, job):
        config['seeds'] = json.loads((ROOT / 'worker-config.json').read_text())['seeds']
        if str(job['id']) not in config['seeds']:
            return await self.fail_current('Unexpected job outside frozen experiment', False)
        try:
            verify()
        except Exception as error:
            return await self.fail_current(str(error), False)
        return await super().run_job(job)

async def main():
    worker = ExperimentWorker()
    worker.broker_url = config['broker_url']
    if worker.broker_url != 'ws://127.0.0.1:4362/v1/worker':
        raise RuntimeError('Experiment broker address is not the isolated local endpoint')
    task = asyncio.create_task(worker.run())
    try:
        while not (ROOT / 'stop').exists() or worker.current_job:
            if task.done():
                await task
            await asyncio.sleep(1)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

asyncio.run(main())
