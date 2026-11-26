export interface LlmProviderInput {
  label: string;
  url: string;
  model: string;
  apiKey?: string;
}

export interface LlmProviderSettings extends Omit<LlmProviderInput, "apiKey"> {
  hasApiKey: boolean;
  revision: string;
}

export interface LlmTurn {
  requestId: string;
  startedAt: number;
  user: string;
  assistant?: string;
  error?: string;
}

export interface LlmConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface LlmConversation extends LlmConversationSummary {
  turns: LlmTurn[];
}
