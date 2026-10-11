import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);
const MAX_WORKFLOW_BYTES = 8 * 1024 * 1024;

function object(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function graph(value: unknown): boolean {
    return object(value) && (
        (Array.isArray(value.nodes) && Array.isArray(value.links))
        || (Object.keys(value).length > 0 && Object.values(value).every(node =>
            object(node) && typeof node.class_type === 'string' && object(node.inputs)))
    );
}

/** Only export ComfyUI graphs, never arbitrary container tags or job internals. */
export function workflowAttachments(tags: Record<string, unknown>, videoName: string): Array<{ attachment: Buffer; name: string }> {
    const parse = (value: unknown): unknown => {
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return null; }
    };
    const workflow = parse(tags.workflow);
    const prompt = parse(tags.prompt);
    const collection = parse(tags.dave_workflows);
    const graphs = Array.isArray(collection) && collection.length
        ? collection.map(value => object(value) ? (graph(value.workflow) ? value.workflow : value.prompt) : null)
        : [graph(workflow) ? workflow : prompt];
    if (!graphs.every(graph)) return [];
    const base = videoName.replace(/\.mp4$/i, '');
    // Discord allows ten attachments total. Keep large scene collections in one
    // JSON bundle; individual scenes can be saved from it and opened in ComfyUI.
    const files = graphs.length <= 9
        ? graphs.map((value, index) => ({ value, name: `${base}${graphs.length > 1 ? `-scene-${index + 1}` : ''}.workflow.json` }))
        : [{ value: { workflows: graphs }, name: `${base}.workflows.json` }];
    const attachments = files.map(({ value, name }) => ({ attachment: Buffer.from(JSON.stringify(value, null, 2) + '\n'), name }));
    return attachments.reduce((bytes, file) => bytes + file.attachment.length, 0) <= MAX_WORKFLOW_BYTES ? attachments : [];
}

export async function videoWorkflowAttachments(path: string, videoName: string): Promise<Array<{ attachment: Buffer; name: string }>> {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
        'format_tags=prompt,workflow,dave_workflows', '-of', 'json', path],
    { timeout: 15_000, maxBuffer: MAX_WORKFLOW_BYTES * 2 });
    return workflowAttachments(JSON.parse(stdout).format?.tags || {}, videoName);
}
