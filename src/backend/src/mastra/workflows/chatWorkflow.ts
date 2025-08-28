// ---------------------------------------------
// Workflows are a Mastra primitive to orchestrate agents and complex sequences of tasks
// Docs: https://mastra.ai/en/docs/workflows/overview
// ---------------------------------------------

import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { starterAgent } from '../agents/starterAgent';
import { streamJSONEvent, streamProgressUpdate } from '../../utils/streamUtils';
import {
  ActionSchema,
  ChatAgentResponseSchema,
  UserApprovalSuspendSchema,
  UserApprovalResumeSchema,
} from './chatWorkflowTypes';

export const ChatInputSchema = z.object({
  prompt: z.string(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  systemPrompt: z.string().optional(),
  streamController: z.any().optional(), // For streaming
  additionalContext: z.any().optional(), // For additional context including suspend data
});

export const ChatOutputSchema = z.object({
  content: z.string(),
  // TODO: Add any structured output fields your application needs
  object: ActionSchema.optional(),
  usage: z.any().optional(),
});

export type ChatOutput = z.infer<typeof ChatOutputSchema>;

// 1. fetchContext – passthrough (placeholder)
const fetchContext = createStep({
  id: 'fetchContext',
  description: 'Fetch any additional context needed for the agent',
  inputSchema: ChatInputSchema,
  outputSchema: ChatInputSchema.extend({
    context: z.any().optional(),
  }),
  execute: async ({ inputData }) => {
    console.log('Chat workflow received input data', inputData);
    // Any context that the frontend wants to send to the agent
    const frontendContext = inputData.prompt;

    // TODO: Implement any context fetching logic here
    // This could include:
    // - Database queries
    // - External API calls
    // - User session data
    // - Application state

    const result = { ...inputData, prompt: frontendContext };

    return result;
  },
});

// 2. buildAgentContext – build message array
const buildAgentContext = createStep({
  id: 'buildAgentContext',
  description: 'Combine fetched information and build LLM messages',
  inputSchema: fetchContext.outputSchema,
  outputSchema: ChatInputSchema.extend({
    messages: z.array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      }),
    ),
  }),
  execute: async ({ inputData }) => {
    const { prompt, temperature, maxTokens, streamController } = inputData;

    const messages = [{ role: 'user' as const, content: prompt }];

    const result = { ...inputData, messages, temperature, maxTokens, streamController };

    return result;
  },
});

// 3. userApproval – suspend workflow for user approval if needed
const userApprovalStep = createStep({
  id: 'userApproval',
  description: 'Wait for user approval before generating response',
  inputSchema: buildAgentContext.outputSchema,
  outputSchema: buildAgentContext.outputSchema.extend({
    approved: z.boolean(),
    feedback: z.string().optional(),
  }),
  suspendSchema: UserApprovalSuspendSchema,
  resumeSchema: UserApprovalResumeSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const { approved, feedback } = resumeData ?? {};

    // Check if this is a sensitive request that needs approval
    const needsApproval = inputData.messages.some(
      (msg) =>
        msg.content.toLowerCase().includes('sensitive') ||
        msg.content.toLowerCase().includes('approve'),
    );

    if (needsApproval && !approved) {
      await suspend({
        pendingResponse: `Request pending approval: ${inputData.messages[0].content}`,
        requiresApproval: true,
      });
      return { ...inputData, approved: false };
    }

    return {
      ...inputData,
      approved: true,
      feedback: feedback || 'Auto-approved',
    };
  },
});

// 4. callAgent – invoke chatAgent
const callAgent = createStep({
  id: 'callAgent',
  description: 'Invoke the chat agent with options',
  inputSchema: userApprovalStep.outputSchema,
  outputSchema: ChatOutputSchema,
  execute: async ({ inputData }) => {
    const { messages, temperature, maxTokens, streamController, systemPrompt } = inputData;

    // Check if streamController is valid before using it
    const isValidStreamController =
      streamController && typeof streamController.enqueue === 'function';

    if (isValidStreamController) {
      try {
        streamProgressUpdate(streamController, 'Generating response...', 'in_progress');
      } catch (error) {
        console.warn('Stream controller is no longer valid:', error);
      }
    }

    const response = await starterAgent.generate(messages, {
      // If system prompt is provided, overwrite the default system prompt for this agent
      ...(systemPrompt ? ({ instructions: systemPrompt } as const) : {}),
      temperature,
      maxTokens,
      experimental_output: ChatAgentResponseSchema,
    });

    const { content, action } = response.object ?? {
      content: response.text,
    };

    const result: ChatOutput = {
      content,
      object: action,
      usage: response.usage,
    };

    console.log('Chat workflow result', result);

    if (isValidStreamController) {
      try {
        streamJSONEvent(streamController, result);
      } catch (error) {
        console.warn('Failed to stream result, stream controller is no longer valid:', error);
      }
    }

    if (isValidStreamController) {
      try {
        streamProgressUpdate(streamController, 'Response generated', 'complete');
      } catch (error) {
        console.warn('Failed to stream completion, stream controller is no longer valid:', error);
      }
    }

    return result;
  },
});

export const chatWorkflow = createWorkflow({
  id: 'chatWorkflow',
  description: 'Chat workflow that handles agent interactions with optional streaming support',
  inputSchema: ChatInputSchema,
  outputSchema: ChatOutputSchema,
})
  .then(fetchContext)
  .then(buildAgentContext)
  .then(userApprovalStep)
  .then(callAgent)
  .commit();
