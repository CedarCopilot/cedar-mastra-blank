import { z } from 'zod';

/**
 * Type definitions for chat workflow
 *
 * Define any custom schemas and types that your chat workflow needs.
 * This file can be extended with action schemas, response formats, etc.
 */

// Example: Basic message schema
export const MessageSchema = z.object({
  content: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  timestamp: z.string().optional(),
});

// Action schemas
export const ActionSchema = z.object({
  type: z.literal('setState'),
  stateKey: z.string(),
  setterKey: z.string(),
  args: z.array(z.any()),
});

export const ChatAgentResponseSchema = z.object({
  content: z.string(),
  action: ActionSchema.optional(),
});

// Suspend and Resume schemas for user approval workflow
export const UserApprovalSuspendSchema = z.object({
  pendingResponse: z.string(),
  requiresApproval: z.boolean(),
});

export const UserApprovalResumeSchema = z.object({
  approved: z.boolean(),
  feedback: z.string().optional(),
});

// Suspend response type
export const SuspendResponseSchema = z.object({
  type: z.literal('humanInTheLoop'),
  status: z.literal('suspended'),
  runId: z.string(),
  stepPath: z.union([z.array(z.array(z.string())), z.array(z.string()), z.string()]), // Support: string[][], string[], or string
  suspendPayload: z.any().optional(), // The actual suspend data from the step
  message: z.string().optional(),
  timeoutMs: z.number().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type SuspendResponse = z.infer<typeof SuspendResponseSchema>;

// TODO: Add your custom workflow types and schemas here
// Examples:
// - Structured output schemas for your agent
// - Action types for UI state management
// - Custom response formats
// - Validation schemas for user inputs
