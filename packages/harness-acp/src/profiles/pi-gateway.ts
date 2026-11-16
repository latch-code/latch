import { AppError } from '@latch/sdk'
import type { GatewayPlace, GatewayLaunch } from './types.ts'
import type { ModelRoute } from '@latch/sdk'

const CONTEXT = 'PI_GATEWAY_CONTEXT_TOKENS'
const OUTPUT = 'PI_GATEWAY_OUTPUT_TOKENS'
const MISSING = 'LATCH_PI_GATEWAY_BUDGET_REQUIRED'
const DATA = 'pi-gateway.json'
const EXTENSION = 'pi-gateway.ts'
export const PI_GATEWAY_PROVIDER = 'latch-gateway'

export function piGatewayBudget(env: Readonly<Record<string, string>>): GatewayPlace['budget'] {
  const context = env[CONTEXT]
  const output = env[OUTPUT]
  if (context === undefined && output === undefined) return undefined
  const number = (value: string | undefined, max: number) => {
    if (value === undefined || !/^[1-9][0-9]{0,7}$/u.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed <= max ? parsed : undefined
  }
  const contextTokens = number(context, 16_777_216)
  const outputTokens = number(output, 1_048_576)
  if (!contextTokens || !outputTokens || outputTokens > contextTokens)
    throw new AppError(
      400,
      'invalid-gateway-budget',
      `Pi 运行预算无效：请在高级环境中同时填写 ${CONTEXT}（1–16777216）与 ${OUTPUT}（1–1048576），输出不得超过上下文，均为正整数。`,
    )
  return { contextTokens, outputTokens }
}

export function piGatewayStartupFailure(stderr: string): string | undefined {
  return stderr.includes(MISSING)
    ? `Pi 的官方目录没有这个模型的明确运行上限。请在 Pi 高级环境中设置 ${CONTEXT} 和 ${OUTPUT} 后新建会话。`
    : undefined
}

const APIS = {
  'chat-completions': 'openai-completions',
  responses: 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
} as const

/** Uses pi's public catalog and registration API. The token stays in the Agent's memory and leaves its child environment. */
const SOURCE = `import { readFileSync } from 'node:fs';
import { getBuiltinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { clampThinkingLevel } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi, openAIResponsesApi, anthropicMessagesApi } from '@earendil-works/pi-ai/compat';

export default function (pi) {
  const data = JSON.parse(readFileSync(new URL('./${DATA}', import.meta.url), 'utf8'));
  const slot = Symbol.for(import.meta.url + ':gateway-token');
  const token = process.env.LMG_TOKEN ?? globalThis[slot];
  if (!token) throw new Error('Latch gateway credential is unavailable');
  // Pi reloads extension factories when switching or restoring a session. Keep only this process's credential in memory.
  Object.defineProperty(globalThis, slot, { value: token, configurable: true });
  delete process.env.LMG_TOKEN;
  const catalog = getBuiltinProviders().flatMap(provider => getBuiltinModels(provider));
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const models = [];
  for (const item of data.models) {
    const known = catalog.filter(model => model.id === item.id && model.api === data.api);
    const bounds = new Map(known.map(model => [model.contextWindow + '/' + model.maxTokens, model]));
    const exact = bounds.size === 1 ? [...bounds.values()][0] : undefined;
    // The service's own declaration comes before pi's catalogue; with no output bound from either, pi's documented default.
    const declared = item.capabilities?.contextTokens;
    const contextWindow = data.budget?.contextTokens ?? declared ?? exact?.contextWindow;
    const maxTokens = data.budget?.outputTokens ?? exact?.maxTokens ?? (declared ? Math.min(16384, declared) : undefined);
    if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxTokens) || contextWindow < 1 || maxTokens < 1 || maxTokens > contextWindow) {
      if (item.id === data.selected) throw new Error('${MISSING}');
      continue;
    }
    const thinking = item.capabilities?.thinking ?? [];
    models.push({
      id: item.id, name: item.id, api: data.api,
      input: item.capabilities?.vision ? ['text', 'image'] : ['text'],
      reasoning: thinking.some(level => level !== 'off'),
      thinkingLevelMap: Object.fromEntries(levels.map(level => [level, thinking.includes(level) ? level : null])),
      contextWindow, maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  const streams = { 'openai-completions': openAICompletionsApi, 'openai-responses': openAIResponsesApi, 'anthropic-messages': anthropicMessagesApi };
  const cap = (value, ceiling) => {
    if (value === undefined) return ceiling;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Latch gateway output budget is invalid');
    return Math.min(value, ceiling);
  };
  // Provider-local dispatch includes compaction and branch summaries, which bypass Agent event hooks.
  const streamSimple = (model, context, options = {}) => {
    const declared = models.find(item => item.id === model.id);
    if (model.provider !== '${PI_GATEWAY_PROVIDER}' || model.api !== data.api || !declared) throw new Error('Latch gateway model is unavailable');
    const contextWindow = cap(model.contextWindow, declared.contextWindow);
    const maxTokens = cap(options.maxTokens, Math.min(contextWindow, cap(model.maxTokens, declared.maxTokens)));
    const safeModel = { ...model, ...declared, provider: '${PI_GATEWAY_PROVIDER}', baseUrl: data.baseURL, contextWindow, maxTokens };
    const level = clampThinkingLevel(safeModel, options.reasoning ?? 'off');
    return streams[data.api]().streamSimple(safeModel, context, { ...options, apiKey: token, maxTokens, onPayload: async (payload, sentModel) => {
      const next = (await options.onPayload?.(payload, sentModel)) ?? payload;
      if (!next || next.model !== model.id) throw new Error('Latch gateway model payload is unavailable');
      const nextPayload = { ...next };
      const fields = data.api === 'openai-completions' ? ['max_tokens', 'max_completion_tokens'] : data.api === 'openai-responses' ? ['max_output_tokens'] : ['max_tokens'];
      const supplied = fields.filter(field => nextPayload[field] !== undefined);
      if (!supplied.length) {
        const original = fields.find(field => payload[field] !== undefined);
        if (!original) throw new Error('Latch gateway output budget is unavailable');
        nextPayload[original] = maxTokens;
      } else for (const field of supplied) nextPayload[field] = cap(nextPayload[field], maxTokens);
      return nextPayload;
    } });
  };
  pi.registerProvider('${PI_GATEWAY_PROVIDER}', { name: 'Latch', api: data.api, apiKey: token, baseUrl: data.baseURL, models, streamSimple });
}
`

export function deliverPiGateway(place: GatewayPlace, route: ModelRoute): GatewayLaunch {
  return {
    args: ['-e', place.file(EXTENSION), '--provider', PI_GATEWAY_PROVIDER, '--model', route.model],
    files: {
      [EXTENSION]: SOURCE,
      [DATA]: `${JSON.stringify({ api: APIS[route.wire], baseURL: place.baseURL, selected: route.model, models: place.models, ...(place.budget ? { budget: place.budget } : {}) })}\n`,
    },
  }
}
