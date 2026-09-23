import type { DragSource } from './project-groups-model';

/** dataTransfer types of the sidebar's drags: a project row, and a group header */
export const PROJECT_MIME = 'application/x-termhub-project';
export const GROUP_MIME = 'application/x-termhub-group';

export function encodeProjectDrag(d: DragSource): string {
  return JSON.stringify({ projectId: d.projectId, from: d.from });
}

/** The dragged project, or null for anything that is not one of ours. */
export function decodeProjectDrag(raw: string): DragSource | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const { projectId, from } = v as Record<string, unknown>;
    return typeof projectId === 'string' && projectId && typeof from === 'string' && from ? { projectId, from } : null;
  } catch {
    return null;
  }
}

/** The dragged group's id, or null when there is none. */
export function decodeGroupDrag(raw: string): string | null {
  return raw || null;
}

/** slot for a drop on a row: before it when the pointer is in its top half, after otherwise */
export function slotFor(rowIndex: number, clientY: number, rect: { top: number; height: number }): number {
  return clientY < rect.top + rect.height / 2 ? rowIndex : rowIndex + 1;
}
