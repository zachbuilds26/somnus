import Groq from 'groq-sdk';
import { log, warn } from '../config';

const GROQ_KEY = process.env.GROQ_API_KEY ?? '';
let groq: Groq | undefined;

function getClient(): Groq | undefined {
  if (!GROQ_KEY) return undefined;
  if (!groq) groq = new Groq({ apiKey: GROQ_KEY });
  return groq;
}

export interface ConversationState {
  step: 'idle' | 'ask_budget' | 'ask_markets' | 'ask_fund' | 'trading' | 'stopped';
  budget?: number;
  markets?: string[];
  totalPnl?: number;
  trades?: number;
  wins?: number;
}

export interface ParsedIntent {
  intent: 'greet' | 'start_trading' | 'set_budget' | 'set_markets' | 'stop' | 'status' | 'help' | 'unknown';
  budget?: number;
  markets?: string[];
  raw: string;
}

const SYSTEM_PROMPT = `You are Somnus, an AI trading agent for DreamDEX Event Contracts on Somnia testnet.

Your job is to understand what the user wants and extract structured data.

The user can:
- Start trading: they want you to trade for them
- Set a budget: how much money to trade with (e.g., "$50", "100 dollars", "50 tUSDC")
- Set markets: which markets to trade (BTC, ETH, or both)
- Stop trading: they want you to stop
- Check status: how is trading going

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "intent": "greet" | "start_trading" | "set_budget" | "set_markets" | "stop" | "status" | "help" | "unknown",
  "budget": number or null,
  "markets": ["BTC"] or ["ETH"] or ["BTC", "ETH"] or null,
  "response": "your conversational response to the user"
}

Rules:
- If user says "trade for me" or "start" or "let's go" → intent: "start_trading"
- If user mentions a dollar amount → intent: "set_budget", budget: the amount
- If user mentions BTC/ETH → intent: "set_markets", markets: the list
- If user says "stop" or "quit" or "enough" → intent: "stop"
- If user says "status" or "how am I doing" → intent: "status"
- If user says "help" → intent: "help"
- Be conversational and friendly in the response field
- Never reveal the JSON structure to the user`;

export async function parseMessage(
  message: string,
  state: ConversationState,
): Promise<ParsedIntent> {
  const client = getClient();
  if (!client) {
    // Fallback: simple pattern matching
    return fallbackParse(message, state);
  }

  try {
    const completion = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Current state: ${JSON.stringify(state)}\n\nUser message: "${message}"` },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    const content = completion.choices[0]?.message?.content ?? '';
    console.log('[ai] groq response:', content);
    // Extract JSON from response (may be wrapped in markdown)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('[ai] no JSON found in response');
      return fallbackParse(message, state);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    console.log('[ai] parsed intent:', parsed.intent, 'response:', parsed.response);
    return {
      intent: (parsed.intent as ParsedIntent['intent']) ?? 'unknown',
      budget: (parsed.budget as number) ?? undefined,
      markets: (parsed.markets as string[]) ?? undefined,
      raw: (parsed.response as string) ?? message,
    };
  } catch (err) {
    console.error('[ai] groq error:', (err as Error).message);
    warn('groq parse error:', (err as Error).message);
    return fallbackParse(message, state);
  }
}

function fallbackParse(message: string, state: ConversationState): ParsedIntent {
  const lower = message.toLowerCase();

  if (lower.match(/\b(hi|hello|hey|yo|sup|gm)\b/)) {
    return { intent: 'greet', raw: message };
  }
  if (lower.match(/\b(trade|start|go|begin|let's|lfg)\b/)) {
    if (state.step === 'idle' || state.step === 'stopped') {
      return { intent: 'start_trading', raw: message };
    }
  }
  if (lower.match(/\b(stop|quit|enough|done|pause)\b/)) {
    return { intent: 'stop', raw: message };
  }
  if (lower.match(/\b(status|how|doing|pnl|profit)\b/)) {
    return { intent: 'status', raw: message };
  }
  if (lower.match(/\b(help|what|how)\b/)) {
    return { intent: 'help', raw: message };
  }

  // Extract budget
  const budgetMatch = lower.match(/\$?(\d+(?:\.\d+)?)/);
  if (budgetMatch && state.step === 'ask_budget') {
    return { intent: 'set_budget', budget: Number(budgetMatch[1]), raw: message };
  }

  // Extract markets
  const markets: string[] = [];
  if (lower.includes('btc') || lower.includes('bitcoin')) markets.push('BTC');
  if (lower.includes('eth') || lower.includes('ethereum')) markets.push('ETH');
  if (markets.length > 0 && (state.step === 'ask_markets' || state.step === 'ask_budget')) {
    if (markets.length === 0) markets.push('BTC', 'ETH');
    return { intent: 'set_markets', markets, raw: message };
  }

  return { intent: 'unknown', raw: message };
}

export function getResponseForIntent(
  intent: ParsedIntent,
  state: ConversationState,
): { message: string; newState: ConversationState } {
  switch (intent.intent) {
    case 'greet':
      return {
        message: `Hey! I'm Somnus — your AI trading agent.\n\nI trade DreamDEX Event Contracts on Somnia testnet.\n\nWant me to trade for you? Just say "trade for me" or "start trading".`,
        newState: state,
      };

    case 'start_trading':
      if (state.step === 'trading') {
        return { message: "I'm already trading for you! Say 'stop' if you want me to stop.", newState: state };
      }
      return {
        message: "Sure! How much do you want to trade with?\n\n(e.g., $10, $50, $100)",
        newState: { ...state, step: 'ask_budget' },
      };

    case 'set_budget':
      if (!intent.budget) {
        return { message: "I didn't catch the amount. How much do you want to trade with?", newState: state };
      }
      if (intent.budget <= 0) {
        return { message: "Please enter an amount greater than $0.", newState: state };
      }
      return {
        message: `Got it — $${intent.budget}.\n\nWhat markets? BTC, ETH, or both?`,
        newState: { ...state, step: 'ask_markets', budget: intent.budget },
      };

    case 'set_markets':
      if (!intent.markets || intent.markets.length === 0) {
        return { message: "Which markets? BTC, ETH, or both?", newState: state };
      }
      return {
        message: "",
        newState: { ...state, step: 'trading', markets: intent.markets },
      };

    case 'stop':
      return {
        message: "Stopped. I'll stop trading now.",
        newState: { ...state, step: 'stopped' },
      };

    case 'status':
      if (state.step !== 'trading') {
        return { message: "I'm not trading right now. Say 'trade for me' to start.", newState: state };
      }
      return {
        message: `Trading ${state.markets?.join(' & ') ?? 'BTC & ETH'} with $${state.budget ?? 0}\n\nTrades: ${state.trades ?? 0} (${state.wins ?? 0} wins)\nP&L: $${(state.totalPnl ?? 0).toFixed(2)}`,
        newState: state,
      };

    case 'help':
      return {
        message: `I'm Somnus — your AI trading agent.\n\nJust talk to me naturally:\n• "trade for me" — start trading\n• "$50" — set your budget\n• "BTC" / "ETH" / "both" — pick markets\n• "stop" — pause trading\n• "status" — see how you're doing\n\nThat's it!`,
        newState: state,
      };

    default:
      return {
        message: intent.raw || "I'm not sure what you mean. Try 'trade for me' or 'help'.",
        newState: state,
      };
  }
}
