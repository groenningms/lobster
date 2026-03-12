import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';

const app = express();
const PORT = 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(__dirname, 'public')));

const BASE = 'http://api.medicinpriser.dk';

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

// Proxy endpoint – avoids CORS issues in the browser
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  try {
    const url = `${BASE}/v1/produkter/virksomtstof/${encodeURIComponent(q)}?format=json`;
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).json({ error: `API error ${upstream.status}` });
    const data = await upstream.json();

    // Enrich all products with price + reimbursement in parallel
    const details = await Promise.all(data.map(p => fetchDetails(p.Varenummer)));
    const enriched = data.map((p, i) => ({ ...p, ...details[i] }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Lobster running at http://localhost:${PORT}`);
});
