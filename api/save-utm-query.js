/**
 * Endpoint para salvar utmQuery quando PIX é criado
 * Replaces: pagamento/save-utm-query.php
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Use /tmp for ephemeral storage on Vercel
const DATA_FILE = path.join(os.tmpdir(), 'utm_queries.json');

export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { transactionId, utmQuery } = req.body;

        if (!transactionId || !utmQuery) {
            return res.status(400).json({ error: 'transactionId and utmQuery are required' });
        }

        let queries = {};
        if (fs.existsSync(DATA_FILE)) {
            try {
                const fileContent = fs.readFileSync(DATA_FILE, 'utf8');
                queries = JSON.parse(fileContent);
            } catch (e) {
                console.error('Error reading data file:', e);
                queries = {};
            }
        }

        // Sao Paulo time
        const savedAt = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

        queries[transactionId] = {
            utmQuery,
            savedAt
        };

        fs.writeFileSync(DATA_FILE, JSON.stringify(queries, null, 2));

        return res.status(200).json({ success: true, transactionId });
    } catch (error) {
        console.error('Internal Error:', error);
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
}
