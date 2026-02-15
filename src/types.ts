export interface PluginConfig {
  openclaw: {
    token: string;
    gatewayUrl: string;
    cliPath: string;
  };
  behavior: {
    privateChat: boolean;
    groupAtOnly: boolean;
    adminQQ: number[];
    commandAdminOnly: boolean;
    userWhitelist: number[];
    groupWhitelist: number[];
    groupBypassUserWhitelist: boolean;
    userBlacklist: number[];
    debounceMs: number;
    resolveReply: boolean;
    replyMaxDepth: number;
    groupSessionMode: 'user' | 'shared';
    replyAtSender: boolean;
    replyQuoteMessage: boolean;
  };
  media: {
    cacheEnabled: boolean;
    cachePath: string;
    cacheMaxSizeMB: number;
    cacheTTLMinutes: number;
  };
}

export interface ExtractedMedia {
  type: 'image' | 'file' | 'voice' | 'video';
  url?: string;
  file_id?: string;
  name?: string;
}

export interface SavedMedia {
  type: string;
  path: string | null;
  url?: string;
  name?: string;
  size?: number;
}

export interface ExtractedMessage {
  extractedText: string;
  extractedMedia: ExtractedMedia[];
}

export interface ChatEventPayload {
  sessionKey: string;
  runId: string;
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: string | MessageContent;
  errorMessage?: string;
}

export interface MessageContent {
  role?: string;
  content?: ContentBlock[] | ContentBlock;
  text?: string;
  stopReason?: string;
}

export interface ContentBlock {
  type?: string;
  text?: string;
}

export interface DebounceResult {
  text: string;
  media: ExtractedMedia[];
}
