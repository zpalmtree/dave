import { execFile } from 'child_process';
import { promisify } from 'util';
import { deflateRawSync } from 'zlib';

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
    const base = videoName.split(/[/\\]/).pop()!.replace(/\.mp4$/i, '');
    const files = graphs.map((value, index) => ({ value, name: `${base}${graphs.length > 1 ? `-scene-${index + 1}` : ''}.workflow.json` }));
    const attachments = files.map(({ value, name }) => ({ attachment: Buffer.from(JSON.stringify(value, null, 2) + '\n'), name }));
    return attachments.reduce((bytes, file) => bytes + file.attachment.length, 0) <= MAX_WORKFLOW_BYTES ? attachments : [];
}

export async function videoWorkflowAttachments(path: string, videoName: string): Promise<Array<{ attachment: Buffer; name: string }>> {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
        'format_tags=prompt,workflow,dave_workflows', '-of', 'json', path],
    { timeout: 15_000, maxBuffer: MAX_WORKFLOW_BYTES * 2 });
    return workflowAttachments(JSON.parse(stdout).format?.tags || {}, videoName);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    return crc >>> 0;
});

/** A small standard ZIP keeps all scenes downloadable without Discord JSON previews. */
export function workflowArchive(files: Array<{ attachment: Buffer; name: string }>, videoName: string): { attachment: Buffer; name: string } | null {
    if (!files.length || files.length > 65535) return null;
    const entries: Buffer[] = [], directory: Buffer[] = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.name.split(/[/\\]/).pop()!);
        const compressed = deflateRawSync(file.attachment);
        let crc = 0xffffffff;
        for (const byte of file.attachment) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
        crc = (crc ^ 0xffffffff) >>> 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // ZIP version 2.0
        local.writeUInt16LE(0x800, 6); // UTF-8 filenames
        local.writeUInt16LE(8, 8); // Deflate
        local.writeUInt16LE(33, 12); // 1980-01-01
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(file.attachment.length, 22);
        local.writeUInt16LE(name.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        local.copy(central, 6, 4, 30);
        central.writeUInt32LE(offset, 42);
        entries.push(local, name, compressed);
        directory.push(central, name);
        offset += local.length + name.length + compressed.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directory.reduce((size, item) => size + item.length, 0), 12);
    end.writeUInt32LE(offset, 16);
    const base = videoName.split(/[/\\]/).pop()!.replace(/\.mp4$/i, '');
    return { attachment: Buffer.concat([...entries, ...directory, end]), name: `${base}.workflows.zip` };
}

export async function videoWorkflowArchive(path: string, videoName: string): Promise<{ attachment: Buffer; name: string } | null> {
    return workflowArchive(await videoWorkflowAttachments(path, videoName), videoName);
}
