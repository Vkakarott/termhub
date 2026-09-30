// The view-model of "Contas e modelo do projeto" (spec 2026-09-30 project AI accounts §8): loads the
// project's block, keeps the edit, saves it. Local state, not a store: nothing else in the app reads it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TProjectAiResponse } from '@/services/api/contract';
import { ApiError } from '@/services/api/errors';
import type { Auth, MobileApi } from '@/services/api/types';
import { canSave, draftFrom, payload, PROJECT_AI_MSG, type ProjectAiDraft } from '../model/project-ai';

export interface ProjectAiDeps {
  api: Pick<MobileApi, 'getProjectAi' | 'saveProjectAi'>;
  session: () => { auth(): Auth; handleApiError(err: unknown): boolean };
}

export interface ProjectAiView {
  /** The block as saved on the server, with what the project may list; null until loaded. */
  saved: TProjectAiResponse | null;
  draft: ProjectAiDraft | null;
  loading: boolean;
  /** Why the load failed (pt-BR). */
  loadError: string | null;
  saving: boolean;
  /** Why the last save failed: the server's own sentence (a 400 names the account), pt-BR. */
  saveError: string | null;
  /** "Contas e modelo salvos." after a save, until the next edit. */
  notice: string | null;
  /** Something changed and every model is valid. */
  canSave: boolean;
  load(): Promise<void>;
  edit(change: (draft: ProjectAiDraft) => ProjectAiDraft): void;
  save(): Promise<void>;
}

const failure = (e: unknown): string => (e instanceof ApiError ? e.message : PROJECT_AI_MSG.network);

export function useProjectAi(projectId: string, deps: ProjectAiDeps): ProjectAiView {
  const { api, session } = deps;
  const [saved, setSaved] = useState<TProjectAiResponse | null>(null);
  const [draft, setDraft] = useState<ProjectAiDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A late answer never lands on a screen that closed (or moved to another project).
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, [projectId]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.getProjectAi(session().auth(), projectId);
      if (!alive.current) return;
      setSaved(res);
      setDraft(draftFrom(res.ai, res.available));
    } catch (e) {
      if (!alive.current || session().handleApiError(e)) return;
      setLoadError(failure(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [api, session, projectId]);

  const edit = useCallback((change: (draft: ProjectAiDraft) => ProjectAiDraft) => {
    setDraft((d) => (d === null ? d : change(d)));
    setNotice(null);
    setSaveError(null);
  }, []);

  const save = useCallback(async () => {
    if (saved === null || draft === null || !canSave(draft, saved.ai, saved.available)) return;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const res = await api.saveProjectAi(session().auth(), projectId, payload(draft, saved.available));
      if (!alive.current) return;
      setSaved(res);
      setDraft(draftFrom(res.ai, res.available));
      setNotice(PROJECT_AI_MSG.saved);
    } catch (e) {
      if (!alive.current || session().handleApiError(e)) return;
      setSaveError(failure(e));
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [api, session, projectId, saved, draft]);

  return {
    saved,
    draft,
    loading,
    loadError,
    saving,
    saveError,
    notice,
    canSave: saved !== null && draft !== null && !saving && canSave(draft, saved.ai, saved.available),
    load,
    edit,
    save,
  };
}
