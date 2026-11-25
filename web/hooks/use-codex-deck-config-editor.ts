import { useEffect, useReducer, useRef } from "react";
import type {
  CodexDeckConfigFileResponse,
  CodexDeckConfigWriteResponse,
} from "@codex-deck/api";
import { applyCodexDeckConfig, getCodexDeckConfig } from "../api";
import {
  applyCodexDeckConfigFormChanges,
  createEmptyCodexDeckConfig,
  parseCodexDeckConfigContent,
  readCodexDeckConfigForm,
  updateCodexDeckConfigContent,
  type EditableCodexDeckConfig,
} from "../codex-deck-config";

interface LoadRequest {
  addHome: boolean;
  refresh: boolean;
}

interface EditorState {
  file: CodexDeckConfigFileResponse | null;
  config: EditableCodexDeckConfig;
  content: string;
  request: LoadRequest | null;
  saving: boolean;
  error: string | null;
  result: CodexDeckConfigWriteResponse | null;
  homeToFocus: number | null;
}

type EditorAction =
  | { type: "load"; request: LoadRequest; preserveDraft?: boolean }
  | { type: "loaded"; request: LoadRequest; file: CodexDeckConfigFileResponse }
  | { type: "load-error"; request: LoadRequest; error: string }
  | { type: "cancel-load" }
  | { type: "edit-form"; config: EditableCodexDeckConfig }
  | { type: "edit-content"; content: string }
  | { type: "add-home" }
  | { type: "clear-home-focus" }
  | { type: "save" }
  | { type: "saved"; file: CodexDeckConfigWriteResponse }
  | { type: "save-error"; error: string };

function hasDraft(state: EditorState): boolean {
  return (
    !!state.file &&
    (state.content !== state.file.content ||
      JSON.stringify(state.config) !==
        JSON.stringify(readCodexDeckConfigForm(state.file)))
  );
}

function appendHome(state: EditorState): EditorState {
  return {
    ...state,
    homeToFocus: state.config.codexHomes.length,
    config: {
      ...state.config,
      codexHomes: [...state.config.codexHomes, { id: "", label: "", path: "" }],
    },
  };
}

function receiveFile(
  state: EditorState,
  file: CodexDeckConfigFileResponse,
): EditorState {
  return {
    ...state,
    file,
    content: file.content,
    config: readCodexDeckConfigForm(file),
    request: null,
    saving: false,
    error: null,
    result: null,
    homeToFocus: null,
  };
}

function reduceEditor(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      if (action.preserveDraft && hasDraft(state)) {
        return action.request.addHome ? appendHome(state) : state;
      }
      return {
        ...state,
        request: action.request,
        error: null,
        result: null,
        homeToFocus: null,
      };
    case "loaded": {
      if (state.request !== action.request) return state;
      const next = receiveFile(state, action.file);
      return action.request.addHome ? appendHome(next) : next;
    }
    case "load-error":
      return state.request === action.request
        ? { ...state, request: null, error: action.error }
        : state;
    case "cancel-load":
      return state.request ? { ...state, request: null } : state;
    case "edit-form": {
      const fileConfig = applyCodexDeckConfigFormChanges(
        parseCodexDeckConfigContent(state.content),
        state.config,
        action.config,
      );
      return {
        ...state,
        config: action.config,
        content: updateCodexDeckConfigContent(state.content, fileConfig),
        request: null,
        error: null,
        result: null,
      };
    }
    case "edit-content":
      return {
        ...state,
        content: action.content,
        config: applyCodexDeckConfigFormChanges(
          state.config,
          parseCodexDeckConfigContent(state.content),
          parseCodexDeckConfigContent(action.content),
        ),
        request: null,
        error: null,
        result: null,
      };
    case "clear-home-focus":
      return { ...state, homeToFocus: null };
    case "add-home":
      return appendHome({ ...state, request: null });
    case "save":
      return {
        ...state,
        request: null,
        saving: true,
        error: null,
        result: null,
      };
    case "saved":
      return { ...receiveFile(state, action.file), result: action.file };
    case "save-error":
      return { ...state, saving: false, error: action.error };
  }
}

export function useCodexDeckConfigEditor({
  open,
  addHomeOnOpen,
  onApplied,
}: {
  open: boolean;
  addHomeOnOpen: boolean;
  onApplied: (response: CodexDeckConfigWriteResponse) => void;
}) {
  const [state, dispatch] = useReducer(reduceEditor, undefined, () => ({
    file: null,
    config: createEmptyCodexDeckConfig(),
    content: "",
    request: null,
    saving: false,
    error: null,
    result: null,
    homeToFocus: null,
  }));
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    dispatch(
      open
        ? {
            type: "load",
            request: { addHome: addHomeOnOpen, refresh: false },
            preserveDraft: true,
          }
        : { type: "cancel-load" },
    );
  }, [open, addHomeOnOpen]);

  useEffect(() => {
    const request = state.request;
    if (!request) return;
    let cancelled = false;
    void getCodexDeckConfig({ refresh: request.refresh }).then(
      (file) => {
        if (!cancelled) dispatch({ type: "loaded", request, file });
      },
      (error: unknown) => {
        if (!cancelled)
          dispatch({
            type: "load-error",
            request,
            error: String(error instanceof Error ? error.message : error),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state.request]);

  const loading = !!state.request && (!state.file || state.request.refresh);
  const isDirty = !!state.file && state.content !== state.file.content;
  const apply = async () => {
    if (!open || loading || state.saving || !state.file || !isDirty) return;
    dispatch({ type: "save" });
    try {
      const file = await applyCodexDeckConfig({
        content: state.content,
        revision: state.file.revision,
      });
      if (!mounted.current) return;
      dispatch({ type: "saved", file });
      onApplied(file);
    } catch (error) {
      if (mounted.current)
        dispatch({
          type: "save-error",
          error: error instanceof Error ? error.message : String(error),
        });
    }
  };

  return {
    ...state,
    loading,
    isDirty,
    apply,
    reload: () =>
      dispatch({ type: "load", request: { addHome: false, refresh: true } }),
    setConfig: (config: EditableCodexDeckConfig) =>
      dispatch({ type: "edit-form", config }),
    setContent: (content: string) =>
      dispatch({ type: "edit-content", content }),
    clearHomeFocus: () => dispatch({ type: "clear-home-focus" }),
    addHome: () => dispatch({ type: "add-home" }),
  };
}
