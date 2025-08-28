import { registerApiRoute } from '@mastra/core/server';
import { ChatInputSchema, ChatOutput, chatWorkflow } from './workflows/chatWorkflow';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createSSEStream, streamJSONEvent } from '../utils/streamUtils';
import { z } from 'zod';
import { SuspendResponse } from './workflows/chatWorkflowTypes';

// Helper function to convert Zod schema to OpenAPI schema
function toOpenApiSchema(schema: Parameters<typeof zodToJsonSchema>[0]) {
  return zodToJsonSchema(schema) as Record<string, unknown>;
}

// Helper function to parse additional context (handles string or object)
function parseAdditionalContext(additionalContext: any): any {
  if (typeof additionalContext === 'string') {
    return JSON.parse(additionalContext);
  }
  return additionalContext;
}

// Helper function to extract suspend data from parsed additional context
function extractSuspendData(parsedAdditionalContext: any) {
  if (!parsedAdditionalContext?.humanInTheLoop?.data) {
    return null;
  }

  const suspendData = Object.values(parsedAdditionalContext.humanInTheLoop.data)[0] as any;
  if (suspendData?.runId && suspendData?.stepPath && suspendData?.state === 'suspended') {
    return suspendData;
  }

  return null;
}

// Helper function to normalize step path for resume operations
function normalizeStepPath(stepPath: any): string[] {
  if (Array.isArray(stepPath)) {
    return Array.isArray(stepPath[0]) ? (stepPath[0] as string[]) : (stepPath as string[]);
  }
  return stepPath ? [stepPath as string] : ['userApproval'];
}

// Helper function to create suspend response
function createSuspendResponse(runId: string, result: any): SuspendResponse {
  const suspendedStepId = result.suspended[0][0];
  const suspendedStepData = result.steps[suspendedStepId];
  const suspendPayload = suspendedStepData?.suspendPayload;

  return {
    type: 'humanInTheLoop',
    status: 'suspended',
    runId: runId,
    stepPath: result.suspended[0],
    suspendPayload: suspendPayload,
    message: 'Workflow suspended again - approval required',
  };
}

// Helper function to resume a workflow
async function resumeWorkflow(
  suspendData: any,
  streamController: any = null,
  context: 'chat' | 'stream' = 'chat',
) {
  console.log(`Resuming suspended workflow from /${context}:`, suspendData.runId);

  const workflowRun = chatWorkflow.createRun({ runId: suspendData.runId });
  const result = await workflowRun.resume({
    resumeData: {
      approved: true, // Auto-approve for now, can be made configurable
      feedback: `Resumed via ${context}`,
      streamController: streamController,
    },
    step: normalizeStepPath(suspendData.stepPath),
  });

  return result;
}

// Schema for resume endpoint
const ResumeInputSchema = z.object({
  runId: z.string(),
  stepPath: z.union([z.array(z.array(z.string())), z.array(z.string()), z.string()]).optional(), // Support: string[][], string[], or string
  resumeData: z.object({
    approved: z.boolean(),
    feedback: z.string().optional(),
  }),
});

/**
 * API routes for the Mastra backend
 *
 * These routes handle chat interactions between the Cedar-OS frontend
 * and your Mastra agents. The chat UI will automatically use these endpoints.
 *
 * - /chat: Standard request-response chat endpoint
 * - /chat/stream: Server-sent events (SSE) endpoint for streaming responses
 */
export const apiRoutes = [
  registerApiRoute('/chat', {
    method: 'POST',
    openapi: {
      requestBody: {
        content: {
          'application/json': {
            schema: toOpenApiSchema(ChatInputSchema),
          },
        },
      },
    },
    handler: async (c) => {
      try {
        const body = await c.req.json();
        const { prompt, temperature, maxTokens, systemPrompt, additionalContext } =
          ChatInputSchema.parse(body);

        const parsedAdditionalContext = parseAdditionalContext(additionalContext);
        const suspendData = extractSuspendData(parsedAdditionalContext);

        // Check if we should resume a suspended workflow
        if (suspendData) {
          try {
            const result = await resumeWorkflow(suspendData, null, 'chat');

            if (result.status === 'success') {
              console.log('Workflow resumed successfully');
              return c.json<ChatOutput>(result.result as ChatOutput);
            } else if (result.status === 'suspended') {
              const suspendResponse = createSuspendResponse(suspendData.runId, result);
              return c.json(suspendResponse);
            } else {
              console.log('Workflow resume failed:', result);
              return c.json(
                {
                  error: `Resume failed with status: ${result.status}`,
                  result: result,
                },
                500,
              );
            }
          } catch (resumeError) {
            console.error('Resume error in /chat:', resumeError);
            return c.json(
              {
                error: resumeError instanceof Error ? resumeError.message : 'Resume failed',
              },
              500,
            );
          }
        }

        // Normal workflow execution (no resume)
        const run = await chatWorkflow.createRunAsync();
        const result = await run.start({
          inputData: { prompt, temperature, maxTokens, systemPrompt, additionalContext },
        });

        if (result.status === 'success') {
          // TODO: Add any response transformation or logging here
          console.log('Sending response', JSON.stringify(result.result, null, 2));
          return c.json<ChatOutput>(result.result as ChatOutput);
        }

        if (result.status === 'suspended') {
          const runId = run.runId;
          console.log('Workflow suspended, runId:', runId);
          console.log('Full suspended result:', JSON.stringify(result, null, 2));

          // Extract the suspended step information
          const suspendedStepId = result.suspended[0][0]; // First suspended step
          const suspendedStepData = result.steps[suspendedStepId];
          const suspendPayload = suspendedStepData?.suspendPayload;

          const suspendResponse: SuspendResponse = {
            type: 'humanInTheLoop',
            status: 'suspended',
            runId: runId,
            stepPath: result.suspended[0], // Use the full step path from suspended array
            suspendPayload: suspendPayload,
            message: 'Workflow suspended - approval required',
          };

          return c.json(suspendResponse);
        }

        // TODO: Handle other workflow statuses if needed
        throw new Error(`Workflow did not complete successfully: ${result.status}`);
      } catch (error) {
        console.error(error);
        return c.json({ error: error instanceof Error ? error.message : 'Internal error' }, 500);
      }
    },
  }),
  registerApiRoute('/chat/stream', {
    method: 'POST',
    openapi: {
      requestBody: {
        content: {
          'application/json': {
            schema: toOpenApiSchema(ChatInputSchema),
          },
        },
      },
    },
    handler: async (c) => {
      try {
        const body = await c.req.json();
        const { prompt, temperature, maxTokens, systemPrompt, additionalContext } =
          ChatInputSchema.parse(body);

        const parsedAdditionalContext = parseAdditionalContext(additionalContext);
        const suspendData = extractSuspendData(parsedAdditionalContext);

        return createSSEStream(async (controller) => {
          // Check if we should resume a suspended workflow
          if (suspendData) {
            try {
              const result = await resumeWorkflow(suspendData, controller, 'stream');

              if (result.status === 'success') {
                console.log('Workflow resumed successfully via stream');
                streamJSONEvent(controller, result.result);
                return;
              } else if (result.status === 'suspended') {
                const suspendResponse = createSuspendResponse(suspendData.runId, result);
                streamJSONEvent(controller, suspendResponse);
                return;
              } else {
                console.log('Workflow resume failed:', result);
                streamJSONEvent(controller, {
                  error: `Resume failed with status: ${result.status}`,
                  result: result,
                });
                return;
              }
            } catch (resumeError) {
              console.error('Resume error in /chat/stream:', resumeError);
              streamJSONEvent(controller, {
                error: resumeError instanceof Error ? resumeError.message : 'Resume failed',
              });
              return;
            }
          }

          // Normal workflow execution (no resume)
          const run = await chatWorkflow.createRunAsync();
          const result = await run.start({
            inputData: {
              prompt,
              temperature,
              maxTokens,
              systemPrompt,
              streamController: controller,
              additionalContext,
            },
          });

          if (result.status === 'suspended') {
            const runId = run.runId;
            console.log('Workflow suspended, runId:', runId);
            console.log('Full suspended result:', JSON.stringify(result, null, 2));

            // Extract the suspended step information
            const suspendedStepId = result.suspended[0][0]; // First suspended step
            const suspendedStepData = result.steps[suspendedStepId];
            const suspendPayload = suspendedStepData?.suspendPayload;

            const suspendResponse: SuspendResponse = {
              type: 'humanInTheLoop',
              status: 'suspended',
              runId: runId,
              stepPath: result.suspended[0], // Use the full step path from suspended array
              suspendPayload: suspendPayload,
              message: 'Workflow suspended - approval required',
            };

            streamJSONEvent(controller, suspendResponse);
            return;
          }

          if (result.status !== 'success') {
            // TODO: Handle workflow errors appropriately
            throw new Error(`Workflow failed: ${result.status}`);
          }
        });
      } catch (error) {
        console.error(error);
        return c.json({ error: error instanceof Error ? error.message : 'Internal error' }, 500);
      }
    },
  }),
  registerApiRoute('/chat/resume', {
    method: 'POST',
    openapi: {
      requestBody: {
        content: {
          'application/json': {
            schema: toOpenApiSchema(ResumeInputSchema),
          },
        },
      },
    },
    handler: async (c) => {
      try {
        const body = await c.req.json();
        const { runId, stepPath, resumeData } = ResumeInputSchema.parse(body);
        const { approved, feedback } = resumeData;

        console.log(
          `Resume request - runId: ${runId}, resumeData: ${JSON.stringify(resumeData)}, stepPath: ${stepPath}`,
        );

        // Resume the workflow with approval data
        // Based on your syntax: workflow.createRun({ runId }).resume({ resumeData, step })
        try {
          const workflowRun = chatWorkflow.createRun({ runId });
          const result = await workflowRun.resume({
            resumeData: {
              ...resumeData,
              streamController: null, // Explicitly set to null for non-streaming resume
            },
            step: Array.isArray(stepPath)
              ? Array.isArray(stepPath[0])
                ? (stepPath[0] as string[])
                : (stepPath as string[])
              : ['userApproval'], // Ensure we pass string[]
          });

          if (result.status === 'success') {
            console.log('Workflow resumed successfully');
            return c.json<ChatOutput>(result.result as ChatOutput);
          } else {
            console.log('Workflow resume result:', result);
            return c.json(
              {
                error: `Resume failed with status: ${result.status}`,
                result: result,
              },
              500,
            );
          }
        } catch (resumeError) {
          console.error('Resume error:', resumeError);
          // Fallback to demonstration response
          if (approved) {
            return c.json({
              content: `Request approved and processed. Feedback: ${feedback || 'No feedback provided'}`,
              object: undefined,
              usage: undefined,
            } as ChatOutput);
          } else {
            return c.json({
              content: 'Request was denied by the user.',
              object: undefined,
              usage: undefined,
            } as ChatOutput);
          }
        }
      } catch (error) {
        console.error(error);
        return c.json({ error: error instanceof Error ? error.message : 'Internal error' }, 500);
      }
    },
  }),
  registerApiRoute('/chat/resume/stream', {
    method: 'POST',
    openapi: {
      requestBody: {
        content: {
          'application/json': {
            schema: toOpenApiSchema(ResumeInputSchema),
          },
        },
      },
    },
    handler: async (c) => {
      try {
        const body = await c.req.json();
        const { runId, stepPath, resumeData } = ResumeInputSchema.parse(body);

        console.log(
          `Resume stream request - runId: ${runId}, resumeData: ${JSON.stringify(resumeData)}, stepPath: ${stepPath}`,
        );

        return createSSEStream(async (controller) => {
          try {
            const workflowRun = chatWorkflow.createRun({ runId });

            // Resume with a fresh stream controller
            const result = await workflowRun.resume({
              resumeData: {
                ...resumeData,
                streamController: controller, // Pass the fresh stream controller
              },
              step: Array.isArray(stepPath)
                ? Array.isArray(stepPath[0])
                  ? (stepPath[0] as string[])
                  : (stepPath as string[])
                : stepPath
                  ? [stepPath as string]
                  : ['userApproval'], // Default fallback
            });

            if (result.status === 'success') {
              console.log('Workflow resumed successfully via stream');
              streamJSONEvent(controller, result.result);
            } else {
              console.log('Workflow resume result via stream:', result);
              streamJSONEvent(controller, {
                error: `Resume failed with status: ${result.status}`,
                result: result,
              });
            }
          } catch (resumeError) {
            console.error('Resume stream error:', resumeError);
            streamJSONEvent(controller, {
              error: resumeError instanceof Error ? resumeError.message : 'Resume failed',
            });
          }
        });
      } catch (error) {
        console.error(error);
        return c.json({ error: error instanceof Error ? error.message : 'Internal error' }, 500);
      }
    },
  }),
];
