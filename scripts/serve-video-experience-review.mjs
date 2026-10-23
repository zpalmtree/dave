import { resolve } from 'node:path';
import { createFinalReviewServer } from './serve-video-audio-review.mjs';
import { EXPERIENCE_REVIEW_PAGE } from './video-experience-review-ui.mjs';

const argument = (key, fallback = null) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const root = argument('run-dir');
if (!root) throw new Error('--run-dir must identify an experiment with renders/human-review/final-videos.json and progress.json');
const review = await createFinalReviewServer({
    runDirectory: resolve(root, 'renders'),
    statusPath: resolve(root, 'progress.json'),
    port: Number(argument('port', '4335')),
    token: argument('token'),
    page: EXPERIENCE_REVIEW_PAGE,
    readOnly: process.argv.includes('--read-only'),
});
console.log(`Blinded video review: ${review.url}`);
async function stop() { await review.close(); process.exit(0); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
