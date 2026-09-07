import { resetInternalIndexForTests, type McpKbSearchClient } from "@diy-agent/kb-rag";
import { createDataPlaneServer } from "../../data-plane/src/server.js";
import { createControlPlaneServer } from "../src/server.js";

export interface CpDpTestHarness {
  cp: ReturnType<typeof createControlPlaneServer>;
  dp: ReturnType<typeof createDataPlaneServer>;
  close: () => Promise<void>;
}

export async function createCpDpHarness(options?: {
  mcpKbSearchClient?: McpKbSearchClient;
  dataPlaneInternalToken?: string;
}): Promise<CpDpTestHarness> {
  resetInternalIndexForTests();

  const dp = createDataPlaneServer({
    port: 0,
    internalToken: options?.dataPlaneInternalToken,
    kbRuntimeDeps: { mcpKbSearchClient: options?.mcpKbSearchClient },
  });
  await new Promise<void>((resolve) => dp.server.once("listening", resolve));

  const cp = createControlPlaneServer({
    port: 0,
    dataPlaneUrl: dp.baseUrl,
    dataPlaneInternalToken: options?.dataPlaneInternalToken,
  });
  await new Promise<void>((resolve) => cp.server.once("listening", resolve));

  return {
    cp,
    dp,
    close: async () => {
      await cp.close();
      await dp.close();
    },
  };
}
