/**
 * Webhook endpoint para receber notificações de pagamento
 * Replaces: pagamento/webhook.php
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Use /tmp for ephemeral storage on Vercel
const LOG_FILE = path.join(os.tmpdir(), 'webhook_log.txt');
const TRANSACTIONS_FILE = path.join(os.tmpdir(), 'transactions.json');
const UTM_QUERIES_FILE = path.join(os.tmpdir(), 'utm_queries.json');

function logWebhook(message, data = null) {
    const timestamp = new Date().toISOString();
    let logMessage = `[${timestamp}] ${message}`;
    if (data) {
        logMessage += "\n" + JSON.stringify(data, null, 2);
    }
    logMessage += "\n---\n";
    try {
        fs.appendFileSync(LOG_FILE, logMessage);
    } catch (e) {
        console.warn('Failed to write to log file', e);
    }
    // Also log to console for Vercel logs
    console.log(message, data ? JSON.stringify(data) : '');
}

function extractTtclidFromUtmQuery(utmQuery) {
    if (!utmQuery) return null;

    // Try JSON first
    try {
        const decoded = JSON.parse(utmQuery);
        if (decoded && decoded.ttclid) return decoded.ttclid;
    } catch (e) {
        // Not JSON
    }

    // Regex for query string
    const matches = /ttclid=([^&\s]+)/.exec(utmQuery);
    if (matches && matches[1]) {
        return decodeURIComponent(matches[1]);
    }
    return null;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const payload = req.body;
        const rawInput = JSON.stringify(payload);

        logWebhook('Webhook recebido', {
            headers: req.headers,
            payload,
            raw_input: rawInput
        });

        // Support both APIs (Supabase vs Railway structure)
        let transactionId = null;
        if (payload.transaction_id) transactionId = payload.transaction_id;
        else if (payload.transactionId) transactionId = payload.transactionId;
        else if (payload._id && payload._id.$oid) transactionId = payload._id.$oid;
        else if (payload._id && typeof payload._id === 'string') transactionId = payload._id;

        if (!transactionId) {
            logWebhook('Erro: transaction_id/transactionId/_id não encontrado no payload', { keys: Object.keys(payload) });
            return res.status(400).json({ error: 'transaction_id, transactionId or _id is required' });
        }

        const vendorId = payload.vendor_id || null;
        const status = payload.status ? String(payload.status).trim() : null;
        const statusLower = status ? status.toLowerCase() : '';
        const valor = payload.valor || payload.amount || null;

        // Description
        const descricao = payload.descricao || (payload.items && payload.items.title) || null;

        // Customer
        let cliente = {};
        if (payload.customer) {
            cliente = {
                nome: payload.customer.name,
                email: payload.customer.email,
                documento: payload.customer.document,
                telefone: payload.customer.phone
            };
        } else {
            cliente = {
                nome: payload.cliente_nome,
                email: payload.cliente_email,
                documento: payload.cliente_documento,
                telefone: null
            };
        }

        const createdAt = payload.created_at || null;

        // Determine Paid Status
        const paidStatuses = ['confirmado', 'pago', 'paid', 'completed', 'aprovado', 'approved', 'COMPLETED'];
        let isPaid = false;
        if (status) {
            if (paidStatuses.includes(statusLower) || paidStatuses.includes(status.toUpperCase())) {
                isPaid = true;
            }
        }

        // Load existing transactions
        let transactions = {};
        if (fs.existsSync(TRANSACTIONS_FILE)) {
            try {
                transactions = JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
            } catch (e) { }
        }

        // TTCLID Extraction Logic
        let ttclid = null;
        let ttclidSource = null;

        // 1. From saved utmQuery
        if (fs.existsSync(UTM_QUERIES_FILE)) {
            try {
                const utmQueries = JSON.parse(fs.readFileSync(UTM_QUERIES_FILE, 'utf8'));
                if (utmQueries[transactionId] && utmQueries[transactionId].utmQuery) {
                    const saved = utmQueries[transactionId].utmQuery;
                    const extracted = extractTtclidFromUtmQuery(saved);
                    if (extracted) {
                        ttclid = extracted;
                        ttclidSource = 'utm_queries_json';
                    }
                }
            } catch (e) { }
        }

        // 2. Direct from payload
        if (!ttclid && payload.ttclid) {
            ttclid = payload.ttclid;
            ttclidSource = 'payload_direto';
        }

        // 3. From payload.utmQuery
        if (!ttclid && payload.utmQuery) {
            const extracted = extractTtclidFromUtmQuery(payload.utmQuery);
            if (extracted) {
                ttclid = extracted;
                ttclidSource = 'utmQuery';
            }
        }

        // 4. From metadata
        if (!ttclid && payload.metadata && payload.metadata.utmQuery) {
            const extracted = extractTtclidFromUtmQuery(payload.metadata.utmQuery);
            if (extracted) {
                ttclid = extracted;
                ttclidSource = 'metadata_utmQuery';
            }
        }

        // 5. From utm query string (Railway)
        if (!ttclid && payload.utm && typeof payload.utm === 'string') {
            const matches = /ttclid=([^&\s]+)/.exec(payload.utm);
            if (matches && matches[1]) {
                ttclid = decodeURIComponent(matches[1]);
                ttclidSource = 'utm_query_string';
            }
        }

        // 6. From existing transaction
        if (!ttclid && transactions[transactionId] && transactions[transactionId].ttclid) {
            ttclid = transactions[transactionId].ttclid;
            ttclidSource = 'transactions_json';
        }

        logWebhook('Processando webhook', {
            transactionId, status, isPaid, ttclid, ttclidSource
        });

        // Valid Date for Sao Paulo
        const now = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });

        // Update Transaction
        transactions[transactionId] = {
            transaction_id: transactionId,
            vendor_id: vendorId,
            status,
            status_lower: statusLower,
            valor,
            amount: valor,
            descricao,
            cliente_nome: cliente.nome,
            cliente_email: cliente.email,
            cliente_documento: cliente.documento,
            cliente_telefone: cliente.telefone,
            created_at: createdAt,
            updated_at: now,
            paid: isPaid,
            ttclid,
            ttclid_source: ttclidSource,
            payload,
            api_version: (payload._id || payload.customer) ? 'railway' : 'supabase'
        };

        fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactions, null, 2));

        logWebhook('Transação salva/atualizada', { transactionId, status, isPaid });
        if (isPaid && statusLower !== 'processando') {
            logWebhook('PAGAMENTO CONFIRMADO!', { transactionId, valor });
        }

        return res.status(200).json({
            success: true,
            message: 'Webhook recebido com sucesso',
            transaction_id: transactionId,
            status,
            paid: isPaid
        });

    } catch (error) {
        logWebhook('Erro ao processar webhook', { error: error.message, stack: error.stack });
        console.error('Webhook Error:', error);
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
}
