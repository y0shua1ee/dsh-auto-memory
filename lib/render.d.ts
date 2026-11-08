export interface RenderMemoryInput {
    content: string;
    memoryDir: string;
    projectKey: string;
    maxBytes: number;
    maxLines: number;
    replacePrevious?: boolean;
    /** The on-disk index was larger than the safety cap and only its start was read. */
    sourceTruncated?: boolean;
}
export interface RenderedMemory {
    text: string;
    digest: string;
    truncated: boolean;
}
/**
 * Render the injected `MEMORY.md` snapshot.
 *
 * The text is framed as a system reminder, escaped so remembered content can
 * never close the frame, bounded by both a line and a byte budget, and hashed.
 * The hash identifies the exact rendered snapshot, so a resumed or compacted
 * session can tell whether this snapshot is still visible.
 */
export declare function renderMemoryContext({ content, memoryDir, projectKey, maxBytes, maxLines, replacePrevious, sourceTruncated }: RenderMemoryInput): RenderedMemory;
