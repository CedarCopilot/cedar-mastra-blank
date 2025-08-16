import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { chatWorkflow } from './workflows/chatWorkflow';
import { apiRoutes } from './apiRegistry';
import { starterAgent } from './agents/starterAgent';

/**
 * Main Mastra configuration
 *
 * This is where you configure your agents, workflows, storage, and other settings.
 * The starter template includes:
 * - A basic agent that can be customized
 * - A chat workflow for handling conversations
 * - In-memory storage (replace with your preferred database)
 * - API routes for the frontend to communicate with
 */
export const mastra = new Mastra({
  agents: { starterAgent },
  workflows: { chatWorkflow },
  storage: new LibSQLStore({
    url: ':memory:', // TODO: Replace with your database URL for persistence
  }),
  telemetry: {
    enabled: true,
  },
  server: {
    apiRoutes,
  },
});
