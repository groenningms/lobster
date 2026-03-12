# Lobster – Medicinpriser Search

A simple web app for searching Danish medicine prices by active substance (virksomt stof), powered by the [Medicinpriser API](http://api.medicinpriser.dk).

## Features

- Autocomplete search field – start typing an active substance (e.g. *paracetamol*) and get instant suggestions
- Results table showing product name, company, strength, and packaging
- Express proxy server to avoid CORS issues with the upstream API

## Requirements

- [Node.js](https://nodejs.org/) 18 or later

## Getting started

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

## Project structure

```
├── public/
│   └── index.html   # Frontend – autocomplete UI
├── server.js        # Express server + API proxy
├── price.js         # Standalone CLI script (node price.js)
└── package.json
```

## API

The app proxies requests to:

```
GET /api/search?q=<substance>
```

which calls `http://api.medicinpriser.dk/v1/produkter/virksomtstof/<substance>?format=json` and returns the JSON response.
