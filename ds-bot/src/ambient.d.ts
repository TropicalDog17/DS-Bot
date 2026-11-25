declare module '@deepseek-ai/dsh-llm' {
  export interface UserMessageInput {
    content: unknown[]
    source?: Record<string, unknown>
  }
  export function createUserMessage(input: UserMessageInput): Record<string, unknown>
  export function createSystemMessage(input: unknown): Record<string, unknown>
  export function createAssistantMessage(input: unknown): Record<string, unknown>
  export function createToolResultMessage(input: unknown): Record<string, unknown>
  export function isAssistantMessage(msg: unknown): boolean
  export function isUserMessage(msg: unknown): boolean
  export function isToolResultMessage(msg: unknown): boolean
  export class LlmAdapter {
    [key: string]: any
  }
  export class LlmError extends Error {
    [key: string]: any
  }
  export class HarnessError extends Error {
    [key: string]: any
  }
  export class BlockAssembler {
    [key: string]: any
  }
  export const resolveRetryPolicy: any
  export const boundContextSummary: any
  export const offloadedImageText: any
  export const resolveImageAttachmentAccess: any
  export const textOnlyImageText: any
}

declare module '@deepseek-ai/dsh-tools'
declare module '@deepseek-ai/dsh-scope'
declare module '@deepseek-ai/dsh-typert-protocol'
declare module '@deepseek-ai/dsh-client-ui-primitives'
declare module 'react'
declare module 'react-dom'
declare module 'playwright'
