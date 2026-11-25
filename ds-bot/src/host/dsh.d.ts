declare module '@deepseek-ai/dsh-llm' {
  export interface UserMessageInput {
    content: unknown[]
    source?: Record<string, unknown>
  }
  export function createUserMessage(input: UserMessageInput): Record<string, unknown>
}
