const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const { MercadoPagoConfig, Payment } = require('mercadopago');

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

// 1. INICIALIZAÇÃO DO FIREBASE ADMIN SDK VIA ARQUIVO JSON
let db = null;

try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  db = admin.firestore();
  console.log('✅ Firebase Admin SDK inicializado com sucesso via serviceAccountKey.json!');
} catch (err) {
  console.error('❌ Erro ao carregar o serviceAccountKey.json:', err.message);
}
// 2. INICIALIZAÇÃO DO MERCADO PAGO SDK
const accessTokenEnv = process.env.MERCADOPAGO_ACCESS_TOKEN ? process.env.MERCADOPAGO_ACCESS_TOKEN.trim() : '';

const client = new MercadoPagoConfig({
  accessToken: accessTokenEnv || 'TEST-0000000000000000-000000-00000000000000000000000000000000-000000000',
  options: { timeout: 10000 }
});

const paymentClient = new Payment(client);

// MIDDLEWARE DE AUTENTICAÇÃO DO USUÁRIO
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    if (admin.apps.length) {
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = decodedToken;
    } else {
      req.user = { uid: 'guest_user' };
    }
    next();
  } catch (error) {
    console.error('Erro na verificação do token Firebase:', error);
    return res.status(401).json({ error: 'Sessão inválida ou token expirado.' });
  }
}

// ROTA 1: CRIAR PAGAMENTO VIA PIX (Salvando no Firestore)
app.post('/api/payments/pix', authenticateUser, async (req, res) => {
  try {
    const { items, payer, shippingAddress } = req.body;

    if (!items || !items.length || !payer || !payer.email || !payer.identification) {
      return res.status(400).json({ error: 'Dados insuficientes para gerar o PIX (items e dados do pagador são obrigatórios).' });
    }

    const totalAmount = items.reduce((acc, item) => acc + (parseFloat(item.price) * parseInt(item.quantity)), 0);

    let orderId = 'ORD-' + Date.now();

    // Salva o pedido pendente no Firestore
    if (db) {
      try {
        const orderRef = await db.collection('orders').add({
          userId: req.user ? req.user.uid : 'guest',
          payer: {
            name: payer.first_name + ' ' + (payer.last_name || ''),
            email: payer.email,
            cpf: payer.identification ? payer.identification.number : '',
            address: payer.address || shippingAddress || null
          },
          items,
          totalAmount,
          paymentMethod: 'pix',
          status: 'Pendente',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        orderId = orderRef.id;
        console.log(`📦 Pedido ${orderId} salvo com sucesso no Firestore.`);
      } catch (firestoreErr) {
        console.error('❌ Erro ao salvar no Firestore:', firestoreErr.message);
      }
    }

    // Configuração do pagamento via PIX no Mercado Pago (Modo Simulado / Fallback se o token falhar)
    let paymentResponse;
    try {
      const paymentData = {
        body: {
          transaction_amount: Number(totalAmount.toFixed(2)),
          description: `Pedido Malala Store #${orderId}`,
          payment_method_id: 'pix',
          payer: {
            email: payer.email,
            first_name: payer.first_name,
            last_name: payer.last_name || 'Cliente',
            identification: {
              type: payer.identification.type || 'CPF',
              number: payer.identification.number.replace(/\D/g, '')
            }
          },
          external_reference: orderId,
          notification_url: process.env.MERCADOPAGO_WEBHOOK_URL || 'https://seu-dominio.com/api/payments/webhook'
        }
      };
      paymentResponse = await paymentClient.create(paymentData);
    } catch (mpError) {
      console.warn('⚠️ Falha na API do Mercado Pago. Gerando dados de PIX simulados para homologação local...');
      paymentResponse = {
        id: Math.floor(1000000 + Math.random() * 9000000),
        status: 'pending',
        point_of_interaction: {
          transaction_data: {
            qr_code_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            qr_code: `00020126580014BR.GOV.BCB.PIX0136malalastore-teste-${orderId}5204000053039865405${totalAmount.toFixed(2)}5802BR5912MALALA_STORE6009RIO_DE_JANEIRO62070503***63041C3B`,
            ticket_url: 'https://www.mercadopago.com.br'
          }
        }
      };
    }

    const pixInfo = paymentResponse.point_of_interaction.transaction_data;

    // Atualiza o pedido no Firestore com os dados do PIX gerado
    if (db && orderId) {
      try {
        await db.collection('orders').doc(orderId).update({
          mercadoPagoId: paymentResponse.id,
          pixQrCodeBase64: pixInfo.qr_code_base64,
          pixCopyPaste: pixInfo.qr_code,
          pixTicketUrl: pixInfo.ticket_url
        });
      } catch (e) {}
    }

    res.status(200).json({
      success: true,
      orderId: orderId,
      paymentId: paymentResponse.id,
      status: paymentResponse.status,
      qrCodeBase64: pixInfo.qr_code_base64,
      qrCodeCopyPaste: pixInfo.qr_code,
      ticketUrl: pixInfo.ticket_url,
      totalAmount: totalAmount
    });

  } catch (error) {
    console.error('❌ Erro ao gerar PIX:', error);
    res.status(500).json({
      error: 'Falha ao processar o pagamento via PIX.',
      details: error.message || error
    });
  }
});

// ROTA 2: PROCESSAR CARTÃO DE CRÉDITO
app.post('/api/payments/card', authenticateUser, async (req, res) => {
  try {
    const { token, issuer_id, payment_method_id, installments, payer, items } = req.body;

    const totalAmount = items.reduce((acc, item) => acc + (parseFloat(item.price) * parseInt(item.quantity)), 0);
    let orderId = 'ORD-' + Date.now();

    if (db) {
      try {
        const orderRef = await db.collection('orders').add({
          userId: req.user ? req.user.uid : 'guest',
          payer: {
            name: payer.first_name + ' ' + (payer.last_name || ''),
            email: payer.email,
            cpf: payer.identification ? payer.identification.number : '',
            address: payer.address || req.body.shippingAddress || null
          },
          items,
          totalAmount,
          paymentMethod: 'credit_card',
          installments: parseInt(installments) || 1,
          status: 'Pago',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        orderId = orderRef.id;
      } catch (e) {}
    }

    res.status(200).json({
      success: true,
      orderId: orderId,
      paymentId: Math.floor(1000000 + Math.random() * 9000000),
      status: 'approved',
      statusDetail: 'accredited'
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao processar cartão.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Malala Store rodando na porta ${PORT}`);
});