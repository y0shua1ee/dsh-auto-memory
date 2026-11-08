import type { Message, MessageSource, TextContent } from "../src/types.js";

export interface CreateUserMessageInput {
  content: TextContent[];
  source?: MessageSource;
}

export function createUserMessage(input: CreateUserMessageInput): Message;

export class HarnessError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string);
}
