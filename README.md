# Lobster – Medicinpriser Chat

A conversational web app for querying Danish medicine prices by active substance (virksomt stof). Powered by the [Medicinpriser API](http://api.medicinpriser.dk) and Azure OpenAI (GPT-4o).

## Features

- **Chat interface** – ask questions in natural language (Danish or English), e.g. *"hvad koster Panodil?"* or *"er der tilskud til ibuprofen?"*
- **Live price lookups** – the AI always fetches fresh data from the Medicinpriser API before answering; never relies on training data for prices
- **Price history** – prices are recorded locally on every lookup; ask the AI to compare prices between periods and it will use the stored history
- **Full product coverage** – all variants returned by the API are surfaced (no arbitrary cutoff)
- **Streaming responses** – answers appear word-by-word as they are generated
- **Price history chart** – click the 📈 button on any product row to view a Chart.js line chart of recorded prices over time
- **Express proxy** – avoids CORS issues with the upstream API; Azure OpenAI auth uses Entra ID (no API key needed)

## Requirements

- [Node.js](https://nodejs.org/) 18 or later
- An Azure OpenAI resource with a GPT-4o deployment
- Azure CLI logged in (`az login`) — the app uses `DefaultAzureCredential` (Entra ID), no API key required

## Getting started

```bash
# Install dependencies
npm install

# Copy the example env file and fill in your Azure OpenAI details
cp .env.example .env

# Start the server
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

| Variable | Description |
|---|---|
| `AZURE_OPENAI_ENDPOINT` | Your Azure OpenAI endpoint, e.g. `https://<resource>.openai.azure.com` |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment name (default: `gpt-4o`) |
| `AZURE_OPENAI_API_VERSION` | API version (default: `2024-12-01-preview`) |

## Project structure

```
├── public/
│   └── index.html        # Chat UI (vanilla JS, Chart.js)
├── server.js             # Express server, API proxy, Azure OpenAI chat endpoint
├── price-history.json    # Auto-generated; stores recorded prices per product
├── price.js              # Standalone CLI script (node price.js)
└── package.json
```

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/search?q=<substance>` | Search products by active substance |
| `POST /api/chat` | SSE chat endpoint — streams AI responses |
| `GET /api/history/:varenummer` | Retrieve stored price history for a product |

### AI tools

The chat endpoint exposes two function tools to the model:

| Tool | Description |
|---|---|
| `lookup_drug_prices` | Fetches live prices and reimbursement data from the Medicinpriser API |
| `get_price_history` | Returns locally stored historical price entries for a substance |
