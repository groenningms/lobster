// price.js (Node 18+ including 25.5)
const url = 'http://api.medicinpriser.dk/v1/produkter/virksomtstof/paracetamol?format=json';

const res = await fetch(url);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const data = await res.json();

console.log(JSON.stringify(data, null, 2));