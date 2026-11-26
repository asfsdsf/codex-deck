export interface DeckPluginViewContext {
  threadId: string | null;
  cwd: string | null;
  model?: string | null;
  args?: string;
}
export interface BuiltinViewProps {
  viewId?: string;
  homeId: string;
  context: DeckPluginViewContext;
}
