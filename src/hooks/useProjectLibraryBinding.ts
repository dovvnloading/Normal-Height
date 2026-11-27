import { useCallback, useRef, useState } from 'react';
import type { TerrainProject } from '../model/types';
import type { ProjectLibraryBinding } from '../model/projectLibrary';

/** Keep document identity outside the portable terrain schema. Undo can cross
 * imported projects while each document retains its current optimistic head. */
export function useProjectLibraryBinding(initial: TerrainProject) {
  const [state] = useState(() => ({
    nextSession: 1,
    sessions: new WeakMap<TerrainProject, string>([[initial, '1']]),
    bindings: new Map<string, ProjectLibraryBinding>(),
  }));
  const current = useRef(initial);
  const [binding, setBindingState] = useState<ProjectLibraryBinding | undefined>();
  const selectProject = useCallback(
    (previous: TerrainProject, next: TerrainProject) => {
      let session = state.sessions.get(next);
      if (!session) {
        session = state.sessions.get(previous) ?? String(++state.nextSession);
        state.sessions.set(previous, session);
        state.sessions.set(next, session);
      }
      current.current = next;
      setBindingState(state.bindings.get(session));
    },
    [state],
  );
  const newDocument = useCallback(
    (project: TerrainProject, nextBinding?: ProjectLibraryBinding) => {
      const session = String(++state.nextSession);
      state.sessions.set(project, session);
      if (nextBinding) state.bindings.set(session, nextBinding);
    },
    [state],
  );
  const setBinding = useCallback(
    (nextBinding?: ProjectLibraryBinding) => {
      const session = state.sessions.get(current.current)!;
      if (nextBinding) state.bindings.set(session, nextBinding);
      else state.bindings.delete(session);
      setBindingState(nextBinding);
    },
    [state],
  );
  const forgetProject = useCallback(
    (projectId: string) => {
      for (const [session, saved] of state.bindings)
        if (saved.projectId === projectId) state.bindings.delete(session);
      setBindingState(state.bindings.get(state.sessions.get(current.current)!));
    },
    [state],
  );
  return { binding, selectProject, newDocument, setBinding, forgetProject };
}
