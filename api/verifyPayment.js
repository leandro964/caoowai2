/**
 * Endpoint para verificação de status de pagamento via polling
 * Replaces: pagamento/verifyPayment.php
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// Use /tmp for ephemeral storage on Vercel
const TRANSACTIONS_FILE = path.join(os.tmpdir(), 'transactions.json');

// Helper to check standard paid statuses
function isPaidStatus(status) {
    if (!status) return false;
    const paidStatuses = ['confirmado', 'pago', 'paid', 'completed', 'aprovado', 'approved', 'COMPLETED'];
    return paidStatuses.includes(status) || paidStatuses.includes(status.toUpperCase()) || paidStatuses.includes(status.toLowerCase());
}

async function checkPaymentViaAPI(transactionId) {
    if (!transactionId) return null;

    const apiUrl = `https://www.pagamentos-seguros.app/api-pix/t6V_bBxlJWT9m2avbTsGZvHu_DjzlLuzhT_WAxGRy_MQ0FjmNOy58eIUfzr01AwLszhkPw6_7gX480wvzpx8hQ/${encodeURIComponent(transactionId)}`;

    return new Promise((resolve) => {
        const req = https.get(apiUrl, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return resolve(null);
            }

            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json) return resolve(null);

                    // Normalize data structure
                    const status = (json.status || 'PENDING').toUpperCase();
                    const statusLower = status.toLowerCase();
                    const isPaid = status === 'COMPLETED';

                    let txId = transactionId;
                    if (json._id && json._id['$oid']) {
                        txId = json._id['$oid'];
                    } else if (json.transactionId) {
                        txId = json.transactionId;
                    }

                    resolve({
                        transaction_id: txId,
                        status: statusLower,
                        valor: json.amount || null,
                        amount: json.amount || null,
                        paid: isPaid,
                        updated_at: new Date().toISOString()
                    });

                } catch (e) {
                    console.error('Error parsing API response:', e);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => {
            console.error('API request error:', e);
            resolve(null);
        });

        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
    });
}

export default async function handler(req, res) {
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
        const { id: transactionId, payment_id: paymentId } = req.body;

        if (!transactionId && !paymentId) {
            return res.status(400).json({ error: 'Transaction ID or Payment ID required' });
        }

        let transaction = null;
        let transactions = {};

        // 1. Check local file (ephemeral)
        if (fs.existsSync(TRANSACTIONS_FILE)) {
            try {
                transactions = JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));

                const searchKey = transactionId || paymentId;

                if (transactions[searchKey]) {
                    transaction = transactions[searchKey];
                } else {
                    // Search values
                    for (const key in transactions) {
                        const tx = transactions[key];
                        if (tx.transaction_id == searchKey || tx.payment_id == searchKey) {
                            transaction = tx;
                            break;
                        }
                    }
                }
            } catch (e) {
                console.warn('Error reading transaction file:', e);
            }
        }

        // 2. Fallback to External API
        if (!transaction) {
            transaction = await checkPaymentViaAPI(transactionId || paymentId);
        }

        if (transaction) {
            const status = (transaction.status || 'pending').toLowerCase();
            let isPaid = false;

            if (transaction.paid !== undefined) {
                isPaid = !!transaction.paid;
            } else {
                isPaid = isPaidStatus(status);
            }

            // Map status
            let mappedStatus = status;
            if (isPaid) {
                mappedStatus = 'paid';
            } else {
                const statusMap = {
                    'pendente': 'pending',
                    'waiting_payment': 'pending',
                    'canceled': 'canceled',
                    'refunded': 'refunded'
                };
                if (statusMap[status]) mappedStatus = statusMap[status];
            }

            return res.status(200).json({
                success: true,
                status: mappedStatus,
                paid: isPaid,
                transaction: {
                    id: transaction.transaction_id || null,
                    transaction_id: transaction.transaction_id || null,
                    payment_id: transaction.payment_id || null,
                    status: mappedStatus,
                    valor: transaction.valor || transaction.amount || null,
                    amount: transaction.valor || transaction.amount || null,
                    updated_at: transaction.updated_at || null
                }
            });

        } else {
            // Not found
            return res.status(200).json({
                success: true,
                status: 'pending',
                paid: false,
                message: 'Transaction not found or still pending'
            });
        }

    } catch (error) {
        console.error('Internal Error:', error);
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
}
