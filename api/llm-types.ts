export interface LlmProviderInput {
  label: string;
  url: string;
  model: string;
  reasoningEffort?: string;
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
  model?: string;
  reasoningEffort?: string;
  assistant?: string;
  thinking?: string;
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
