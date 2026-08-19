/**
 * Model configuration for the PI Agent.
 *
 * Any OpenAI-compatible endpoint works, and endpoints name models differently:
 * the same build may be `gpt-4o` on one, `openai/gpt-4o` on a router and
 * `default/deepseek-v4-flash` on a corporate proxy. So the UI sends a stable
 * alias (`flash`, `pro`) and this module maps it to the id the endpoint expects.
 * Pointing a deployment at another endpoint is configuration only.
 *
 * Environment:
 *   LLM_API_KEY      Required. Bearer token.
 *   LLM_BASE_URL     Required. Endpoint base URL including the version prefix
 *                    it expects; /chat/completions is appended.
 *   LLM_MODELS       Required. JSON array of entries, see parseEntries.
 *   LLM_PROVIDER_ID  Optional, default "llm". Names the provider to pi-ai and
 *                    selects its request-compatibility profile: an unknown id
 *                    yields plain OpenAI semantics, while a known id such as
 *                    "openai", "deepseek" or "anthropic" turns on that family's
 *                    quirks. Per-entry `compat` overrides either way.
 */
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const DEFAULT_PROVIDER_ID = "llm";
const API_KEY_ENV_VAR = "LLM_API_KEY";

export interface ModelChoice {
  /** Stable key used by the UI and persisted sessions. */
  alias: string;
  /** Model id sent to the endpoint. */
  wireModelId: string;
  label: string;
  detail: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface ModelCatalog {
  providerId: string;
  baseUrl: string;
  choices: ModelChoice[];
  /** Alias -> pi-ai model, whose `id` is the wire id. */
  piModels: Map<string, Model<Api>>;
}

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(`Invalid PI Agent model configuration: ${message}`);
    this.name = "ModelConfigError";
  }
}

export class ModelValidationError extends Error {
  constructor(
    readonly modelId: string,
    readonly available: string[],
  ) {
    super(`Unsupported PI Agent model: ${modelId}. Configured: ${available.join(", ")}`);
    this.name = "ModelValidationError";
  }
}

function readEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) throw new ModelConfigError(`${name} is required`);
  return value;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ModelConfigError(`LLM_BASE_URL is not a valid URL: ${value}`);
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname))) {
    throw new ModelConfigError("LLM_BASE_URL must use HTTPS unless it targets loopback");
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * `alias` and `model` are required. `compat` is passed to pi-ai untouched and is
 * only needed when an entry's model family differs from LLM_PROVIDER_ID, or
 * when the endpoint rejects part of the default request shape. The first entry
 * is the default selection.
 */
function parseEntries(raw: string): ModelChoice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ModelConfigError(
      `LLM_MODELS must be a JSON array (${error instanceof Error ? error.message : "parse error"})`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ModelConfigError("LLM_MODELS must be a non-empty JSON array");
  }

  return parsed.map((item, index) => {
    const entry = (typeof item === "object" && item !== null ? item : {}) as Record<
      string,
      unknown
    >;
    const alias = typeof entry.alias === "string" ? entry.alias.trim() : "";
    const wireModelId = typeof entry.model === "string" ? entry.model.trim() : "";
    if (!alias || !wireModelId) {
      throw new ModelConfigError(`LLM_MODELS[${index}] needs both "alias" and "model"`);
    }
    return {
      alias,
      wireModelId,
      label: typeof entry.label === "string" ? entry.label : alias,
      detail: typeof entry.detail === "string" ? entry.detail : "",
      contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : 128_000,
      maxTokens: typeof entry.maxTokens === "number" ? entry.maxTokens : 8_192,
      reasoning: entry.reasoning === true,
      ...(typeof entry.compat === "object" && entry.compat !== null
        ? { compat: entry.compat }
        : {}),
    };
  });
}

let catalog: ModelCatalog | null = null;
let models: MutableModels | null = null;

export function getModelCatalog(): ModelCatalog {
  if (catalog) return catalog;
  requireEnv(API_KEY_ENV_VAR);
  const providerId = readEnv("LLM_PROVIDER_ID") ?? DEFAULT_PROVIDER_ID;
  const baseUrl = normalizeBaseUrl(requireEnv("LLM_BASE_URL"));
  const entries = parseEntries(requireEnv("LLM_MODELS"));

  const piModels = new Map<string, Model<Api>>();
  for (const entry of entries) {
    const { alias, wireModelId, label, ...rest } = entry as ModelChoice & { compat?: unknown };
    piModels.set(alias, {
      ...rest,
      id: wireModelId,
      name: label,
      api: "openai-completions",
      provider: providerId,
      baseUrl,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as Model<Api>);
  }
  catalog = { providerId, baseUrl, choices: entries, piModels };
  return catalog;
}

export function getApiKey(): string | undefined {
  return readEnv(API_KEY_ENV_VAR);
}

export function getConfiguredModels(): MutableModels {
  if (models) return models;
  const { providerId, baseUrl, piModels } = getModelCatalog();
  models = createModels({
    credentials: {
      read: async (id: string) => {
        const key = id === providerId ? getApiKey() : undefined;
        return key ? { type: "api_key" as const, key } : undefined;
      },
      modify: async () => undefined,
      delete: async () => {},
      list: async () => [],
    },
  });
  models.setProvider(
    createProvider({
      id: providerId,
      baseUrl,
      auth: { apiKey: envApiKeyAuth(`${providerId} API key`, [API_KEY_ENV_VAR]) },
      // Aliases may share a wire id; the provider list is keyed by it.
      models: [...new Map([...piModels.values()].map((model) => [model.id, model])).values()],
      api: openAICompletionsApi(),
    }),
  );
  return models;
}

/** Defaults to the first configured entry. Throws ModelValidationError. */
export function resolveModelChoice(alias?: string): ModelChoice {
  const { choices } = getModelCatalog();
  if (!alias?.trim()) return choices[0]!;
  const choice = choices.find((candidate) => candidate.alias === alias.trim());
  if (!choice) {
    throw new ModelValidationError(
      alias,
      choices.map((candidate) => candidate.alias),
    );
  }
  return choice;
}

export function getPiModel(alias: string): Model<Api> {
  return getModelCatalog().piModels.get(alias)!;
}
