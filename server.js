import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';

const app = express();
const PORT = 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(__dirname, 'public')));

// Proxy endpoint – avoids CORS issues in the browser
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  try {
    const url = `http://api.medicinpriser.dk/v1/produkter/virksomtstof/${encodeURIComponent(q)}?format=json`;
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).json({ error: `API error ${upstream.status}` });
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Lobster running at http://localhost:${PORT}`);
});
