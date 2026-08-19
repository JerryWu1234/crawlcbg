import { CustomOpenAIClient, Stagehand } from "@browserbasehq/stagehand";
import OpenAI from "openai";

const DEFAULT_CDP_URL = "ws://127.0.0.1:9222/devtools/browser/";

let stagehand: Stagehand | null = null;
let openaiClient: OpenAI | null = null;

/**
 * Shared OpenAI-compatible client for the browser automation and script
 * generation. `LLM_UTILITY_MODEL` is the wire model id for the configured
 * endpoint; the PI Agent has its own catalog in LLM_MODELS.
 */
function readLlmConfig(): { apiKey: string; baseURL: string; model: string } {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseURL = process.env.LLM_BASE_URL?.trim();
  const model = process.env.LLM_UTILITY_MODEL?.trim();
  if (!apiKey || !baseURL || !model) {
    throw new Error(
      "Please configure LLM_API_KEY, LLM_BASE_URL and LLM_UTILITY_MODEL in the `.env` file at the root of the project.",
    );
  }
  return { apiKey, baseURL, model };
}

export function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;
  const { apiKey, baseURL } = readLlmConfig();
  openaiClient = new OpenAI({ apiKey, baseURL });
  return openaiClient;
}

export function getUtilityModel(): string {
  return readLlmConfig().model;
}

async function initStagehand(): Promise<Stagehand> {
  const configuredCdpUrl = process.env.CDP_URL?.trim();
  const cdpUrl = configuredCdpUrl || DEFAULT_CDP_URL;

  const customLlmClient = new CustomOpenAIClient({
    modelName: getUtilityModel(),
    client: getOpenAIClient(),
  });

  const sh = new Stagehand({
    env: "LOCAL",
    llmClient: customLlmClient,
    verbose: 1,
    localBrowserLaunchOptions: {
      headless: false,
      cdpUrl,
    },
  });

  console.log(
    configuredCdpUrl
      ? `Connecting Stagehand to browser at ${cdpUrl}...`
      : `CDP_URL is not configured; connecting Stagehand to default browser at ${cdpUrl}...`,
  );

  await sh.init();
  console.log("Stagehand connected to browser successfully.");
  return sh;
}

let stagehandConnectionPromise: Promise<Stagehand> | null = null;

function waitForStagehandConnection(
  connectionPromise: Promise<Stagehand>,
  timeoutMs = 12_000,
): Promise<Stagehand> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Stagehand connection timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    connectionPromise.then(
      (connectedStagehand) => {
        clearTimeout(timeout);
        resolve(connectedStagehand);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function ensureStagehand(): Promise<Stagehand> {
  if (stagehand) {
    try {
      if (stagehand.context && typeof stagehand.context.pages === "function") {
        stagehand.context.pages();
        return stagehand;
      }
    } catch (e) {
      console.warn(
        "[Stagehand] Connection lost or context invalidated, attempting reconnect...",
        e,
      );
      stagehand = null;
    }
  }

  if (!stagehandConnectionPromise) {
    console.log("[Stagehand] Connecting/reconnecting to Chrome browser...");
    stagehandConnectionPromise = initStagehand()
      .then((connectedStagehand) => {
        stagehand = connectedStagehand;
        return connectedStagehand;
      })
      .catch((err) => {
        console.error("[Stagehand] Connection failed:", err);
        throw err;
      })
      .finally(() => {
        stagehandConnectionPromise = null;
      });
  }

  return waitForStagehandConnection(stagehandConnectionPromise);
}
