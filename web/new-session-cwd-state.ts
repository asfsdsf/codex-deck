export interface NewSessionCwdState {
  value: string;
  preserveManualEmpty: boolean;
}

export const EMPTY_NEW_SESSION_CWD_STATE: NewSessionCwdState = {
  value: "",
  preserveManualEmpty: false,
};

export function setNewSessionCwdFromUserInput(
  nextValue: string,
): NewSessionCwdState {
  return {
    value: nextValue,
    preserveManualEmpty: nextValue === "",
  };
}

export function clearNewSessionCwdForProjectSelection(): NewSessionCwdState {
  return {
    value: "",
    preserveManualEmpty: true,
  };
}

interface MaybeAutoFillNewSessionCwdParams {
  selectedProject: string | null;
  candidates: string[];
}

export function maybeAutoFillNewSessionCwd(
  state: NewSessionCwdState,
  params: MaybeAutoFillNewSessionCwdParams,
): NewSessionCwdState {
  if (
    state.value ||
    state.preserveManualEmpty ||
    params.selectedProject ||
    params.candidates.length !== 1
  ) {
    return state;
  }

  return {
    value: params.candidates[0] ?? "",
    preserveManualEmpty: false,
  };
}
