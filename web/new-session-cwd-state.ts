export interface NewSessionCwdState {
  value: string;
}

export const EMPTY_NEW_SESSION_CWD_STATE: NewSessionCwdState = {
  value: "",
};

export function setNewSessionCwdFromUserInput(
  nextValue: string,
): NewSessionCwdState {
  return {
    value: nextValue,
  };
}

export function clearNewSessionCwdForProjectSelection(): NewSessionCwdState {
  return {
    value: "",
  };
}

export function resolveNewSessionCwdForCreate(
  userInput: string,
  currentPath: string,
): string {
  return userInput.trim() || currentPath.trim();
}
