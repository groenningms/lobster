import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { AzureOpenAI } from 'openai';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';

// ── Azure OpenAI client (Entra ID auth, lazy init) ──
let _client = null;
let MODEL   = '';

function getClient() {
  if (_client) return _client;
  const endpoint   = process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview';
  if (!endpoint) throw new Error('Set AZURE_OPENAI_ENDPOINT in your .env file.');
  const tokenProvider = getBearerTokenProvider(
    new DefaultAzureCredential(),
    'https://cognitiveservices.azure.com/.default'
  );
  MODEL   = deployment;
  _client = new AzureOpenAI({ endpoint, azureADTokenProvider: tokenProvider, apiVersion, deployment });
  return _client;
}

const app = express();
const PORT = 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const BASE = 'http://api.medicinpriser.dk';

// ── Price history (persisted to price-history.json) ──
const HISTORY_FILE = path.join(__dirname, 'price-history.json');

let priceHistory = (() => {
  if (!existsSync(HISTORY_FILE)) return {};
  try { return JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch { return {}; }
})();

function savePrice(varenummer, price, name) {
  if (!priceHistory[varenummer]) priceHistory[varenummer] = { name, entries: [] };
  const today = new Date().toISOString().slice(0, 10);
  const idx = priceHistory[varenummer].entries.findIndex(e => e.date === today);
  if (idx >= 0) {
    priceHistory[varenummer].entries[idx].price = price;
  } else {
    priceHistory[varenummer].entries.push({ date: today, price });
  }
  priceHistory[varenummer].name = name;
  try { writeFileSync(HISTORY_FILE, JSON.stringify(priceHistory, null, 2)); } catch { /* ignore */ }
}

// Fetch price + reimbursement details for a single product
async function fetchDetails(varenummer) {
  try {
    const r = await fetch(`${BASE}/v1/produkter/detaljer/${varenummer}?format=json`);
    if (!r.ok) return {};
    const d = await r.json();
    return {
      PrisPrPakning: d.PrisPrPakning ?? null,
      TilskudKode:   d.TilskudKode   ?? '',
      TilskudTekst:  d.TilskudTekst  ?? '',
    };
  } catch {
    return {};
  }
}

// ── Shared drug-search helper (used by both REST and chat endpoints) ──
async function searchDrug(q) {
  const url = `${BASE}/v1/produkter/virksomtstof/${encodeURIComponent(q)}?format=json`;
  const upstream = await fetch(url);
  if (!upstream.ok) throw new Error(`API error ${upstream.status}`);
  const data = await upstream.json();
  const details = await Promise.all(data.map(p => fetchDetails(p.Varenummer)));
  const enriched = data.map((p, i) => ({ ...p, ...details[i] }));
  enriched.forEach(p => {
    if (p.PrisPrPakning != null) savePrice(p.Varenummer, p.PrisPrPakning, p.Navn);
  });
  return enriched;
}

// Proxy endpoint – avoids CORS issues
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    res.json(await searchDrug(q));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Chat endpoint ──
const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'lookup_drug_prices',
      description: 'Look up current prices, reimbursement status and packaging for a medicine in Denmark by its active substance (virksomt stof).',
      parameters: {
        type: 'object',
        properties: {
          substance: {
            type: 'string',
            description: 'Active substance name in Danish/Latin, e.g. paracetamol, ibuprofen, metformin',
          },
        },
        required: ['substance'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_price_history',
      description: 'Get the stored price history for a medicine by its active substance. Returns all historical price entries recorded locally, with dates and prices. Use this to answer questions about price changes over time or to compare prices between different periods.',
      parameters: {
        type: 'object',
        properties: {
          substance: {
            type: 'string',
            description: 'Active substance name in Danish/Latin, e.g. paracetamol, ibuprofen, metformin',
          },
        },
        required: ['substance'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_price_history',
      description: 'Query and rank all products stored in the local price history database. Use this to answer questions like "what is the most expensive drug?", "what are the cheapest medicines?", or "which products cost more than X kr?". Only covers products that have been looked up before in this session — not an exhaustive list of all Danish medicines.',
      parameters: {
        type: 'object',
        properties: {
          sort: {
            type: 'string',
            enum: ['price_desc', 'price_asc'],
            description: 'Sort order: price_desc for most expensive first, price_asc for cheapest first.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results to return. Default 10.',
          },
          min_price: {
            type: 'number',
            description: 'Optional: only return products with latest price above this value (DKK).',
          },
          max_price: {
            type: 'number',
            description: 'Optional: only return products with latest price below this value (DKK).',
          },
        },
        required: ['sort'],
      },
    },
  },
];

function getPriceHistoryForSubstance(substance) {
  const q = substance.toLowerCase();
  return Object.entries(priceHistory)
    .filter(([, d]) => d.name.toLowerCase().includes(q))
    .map(([varenummer, d]) => ({ varenummer, name: d.name, entries: d.entries }));
}

function queryPriceHistory({ sort, limit = 10, min_price, max_price }) {
  const rows = Object.entries(priceHistory)
    .map(([varenummer, d]) => {
      const latest = d.entries.at(-1);
      return { varenummer, name: d.name, latestDate: latest?.date, latestPrice: latest?.price ?? null };
    })
    .filter(r => r.latestPrice !== null)
    .filter(r => min_price === undefined || r.latestPrice >= min_price)
    .filter(r => max_price === undefined || r.latestPrice <= max_price);
  rows.sort((a, b) => sort === 'price_asc' ? a.latestPrice - b.latestPrice : b.latestPrice - a.latestPrice);
  return rows.slice(0, limit);
}

const SYSTEM_PROMPT = `Du er en assistent til den danske medicin-prisdatabase (medicinpriser.dk).
Du hjælper brugere med at finde aktuelle priser, tilskudsstatus og produktoplysninger for lægemidler solgt i Danmark.

VIGTIGT: Brug ALTID lookup_drug_prices-værktøjet til at hente live data, FØR du svarer på spørgsmål om et lægemiddel.
Brug ALDRIG din træningsviden til at besvare spørgsmål om priser, tilgængelighed eller tilskud – disse oplysninger er forældet.
Al prisinformation SKAL komme fra API-kaldet. Dagens dato bruges automatisk af API'et, så priserne er altid opdaterede.

Hvis brugeren spørger om prisudvikling eller sammenligning over tid, brug get_price_history-værktøjet.
Hvis der ikke er historiske data for den ønskede periode, fortæl brugeren det tydeligt.

Hvis brugeren spørger om det dyreste, billigste eller sammenligner priser på tværs af lægemidler (uden at nævne et specifikt stof),
brug query_price_history-værktøjet. VIGTIGT: databasen indeholder kun lægemidler der tidligere er blevet slået op – det er ikke
en udtømmende liste over alle danske lægemidler. Oplys altid brugeren om denne begrænsning i svaret.

Hvis brugeren stiller et generelt spørgsmål der ikke handler om et specifikt lægemiddel, kan du svare uden at kalde værktøjet.
Svar på det sprog brugeren skriver på. Vær kortfattet. Brug danske kroner (kr) ved priser.
Brug relevante emojis i dine svar for at gøre dem mere overskuelige – f.eks. 💊 ved lægemidler, 💰 ved priser, 📦 ved pakningsstørrelser, ✅ ved tilskud, ❌ hvor der ikke er tilskud, 📈 ved prisstigninger, 📉 ved prisfald.`;

app.post('/api/chat', async (req, res) => {
  const messages = req.body.messages;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

  if (!process.env.AZURE_OPENAI_ENDPOINT) {
    return res.status(500).json({ error: 'Set AZURE_OPENAI_ENDPOINT in your .env file.' });
  }

  // Use SSE so the browser receives text as it is generated
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const msgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];

    // Single streaming first call – detects tool calls on the fly so no
    // wasted round-trip; plain answers start appearing immediately.
    const firstStream = await getClient().chat.completions.create({
      model: MODEL, messages: msgs, tools: CHAT_TOOLS, tool_choice: 'auto', stream: true,
    });

    // Track tool calls by their streaming index to handle parallel tool calls correctly
    const toolCallMap = {}; // index → { id, name, arguments }
    let isToolCall = false;

    for await (const chunk of firstStream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.tool_calls?.length) {
        isToolCall = true;
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallMap[idx]) toolCallMap[idx] = { id: '', name: '', arguments: '' };
          if (tc.id)                   toolCallMap[idx].id         = tc.id;
          if (tc.function?.name)       toolCallMap[idx].name       = tc.function.name;
          if (tc.function?.arguments)  toolCallMap[idx].arguments += tc.function.arguments;
        }
      } else if (delta?.content && !isToolCall) {
        // No tool call – stream directly to the client right now
        send({ type: 'delta', text: delta.content });
      }
    }

    if (isToolCall) {
      const toolCallList = Object.values(toolCallMap);

      // Execute all tool calls (possibly in parallel)
      const toolResults = await Promise.all(toolCallList.map(async tc => {
        try {
          const args = JSON.parse(tc.arguments);
          if (tc.name === 'lookup_drug_prices') {
            const drugData = await searchDrug(args.substance);
            return { id: tc.id, content: JSON.stringify(drugData) };
          } else if (tc.name === 'get_price_history') {
            const history = getPriceHistoryForSubstance(args.substance);
            return { id: tc.id, content: JSON.stringify(history) };
          } else if (tc.name === 'query_price_history') {
            const results = queryPriceHistory(args);
            return { id: tc.id, content: JSON.stringify(results) };
          }
          return { id: tc.id, content: JSON.stringify({ error: 'Unknown tool' }) };
        } catch (e) {
          return { id: tc.id, content: JSON.stringify({ error: e.message }) };
        }
      }));

      const msgs2 = [
        ...msgs,
        {
          role: 'assistant',
          tool_calls: toolCallList.map(tc => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        },
        ...toolResults.map(tr => ({ role: 'tool', tool_call_id: tr.id, content: tr.content })),
      ];

      const secondStream = await getClient().chat.completions.create({
        model: MODEL, messages: msgs2, stream: true,
      });
      for await (const chunk of secondStream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) send({ type: 'delta', text });
      }
    }

    send({ type: 'done' });
    res.end();
  } catch (err) {
    send({ type: 'error', message: err.message });
    res.end();
  }
});

// Return stored price history for a single product
app.get('/api/history/:varenummer', (req, res) => {
  const entry = priceHistory[req.params.varenummer];
  res.json(entry ?? { name: '', entries: [] });
});

app.listen(PORT, () => {
  console.log(`Lobster running at http://localhost:${PORT}`);
});
