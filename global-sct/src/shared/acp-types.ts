export type { AgentCapabilities, ClientCapabilities, ContentBlock, InitializeRequest, InitializeResponse, PermissionOption, PromptRequest, SessionNotification, SessionUpdate, StopReason, ToolCall, ToolCallUpdate, AgentConnection, ClientConnection } from '@agentclientprotocol/sdk'

// ACP v1 target: the runner must not depend on client fs/* or terminal/*; draft v2 removes them.
