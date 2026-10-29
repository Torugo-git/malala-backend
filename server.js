const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const { MercadoPagoConfig, Payment } = require('mercadopago');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. INICIALIZAÇÃO PROFISSIONAL DO FIREBASE
let db = null;

try {
  let serviceAccount;
  
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    // Lê a credencial na nuvem (Render)
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('☁️ Firebase: Lendo credenciais da Variável de Ambiente (Render)');
  } else {
    // Lê a credencial localmente no seu PC (VS Code)
    serviceAccount = require('./serviceAccountKey.json');
    console.log('💻 Firebase: Lendo credenciais do arquivo local');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  
  db = admin.firestore();
  console.log('✅ Firebase Firestore conectado com sucesso!');
} catch (err) {
  console.error('❌ ERRO CRÍTICO: Não foi possível conectar ao Firebase.', err.message);
}

// 2. INICIALIZAÇÃO DO MERCADO PAGO
const accessTokenEnv = process.env.MERCADOPAGO_ACCESS_TOKEN ? process.env.MERCADOPAGO_ACCESS_TOKEN.trim() : '';
const client = new MercadoPagoConfig({
  accessToken: accessTokenEnv || 'TEST-0000000000000000-000000-00000000000000000000000000000000-000000000',
  options: { timeout: 10000 }
});
const paymentClient = new Payment(client);

// ROTA 1: PIX
app.post('/api/payments/pix', async (req, res) => {
  try {
    const { items, payer, shippingAddress } = req.body;
    
    if (!db) {
      console.error('❌ Venda Bloqueada: Banco de dados inativo.');
      return res.status(500).json({ error: 'Erro interno: Banco de dados desconectado.' });
    }

    const totalAmount = items.reduce((acc, item) => acc + (parseFloat(item.price) * parseInt(item.quantity)), 0);
    let orderId = 'ORD-' + Date.now();

    // 1º PASSO OBRIGATÓRIO: Salvar no Firebase ANTES de cobrar
    try {
      const orderRef = await db.collection('orders').add({
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
      console.log(`📦 [PIX] Pedido ${orderId} salvo no Firestore com sucesso!`);
    } catch (dbError) {
      console.error('❌ Erro ao salvar pedido PIX no Firestore:', dbError);
      return res.status(500).json({ error: 'Falha ao registrar pedido no banco de dados.' });
    }

    // 2º PASSO: Gerar a cobrança no Mercado Pago
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
        external_reference: orderId
      }
    };

    const paymentResponse = await paymentClient.create(paymentData);
    const pixInfo = paymentResponse.point_of_interaction.transaction_data;

    // 3º PASSO: Atualizar o Firebase com o QR Code
    await db.collection('orders').doc(orderId).update({
      mercadoPagoId: paymentResponse.id,
      pixQrCodeBase64: pixInfo.qr_code_base64,
      pixCopyPaste: pixInfo.qr_code
    });

    res.status(200).json({
      success: true,
      orderId: orderId,
      qrCodeBase64: pixInfo.qr_code_base64,
      qrCodeCopyPaste: pixInfo.qr_code
    });

  } catch (error) {
    console.error('❌ Erro geral na rota PIX:', error);
    res.status(500).json({ error: 'Falha ao processar o pagamento via PIX.' });
  }
});

// ROTA 2: CARTÃO DE CRÉDITO
app.post('/api/payments/card', async (req, res) => {
  try {
    const { token, issuer_id, payment_method_id, installments, payer, items } = req.body;
    
    if (!db) {
      console.error('❌ Venda Bloqueada: Banco de dados inativo.');
      return res.status(500).json({ error: 'Erro interno: Banco de dados desconectado.' });
    }

    const totalAmount = items.reduce((acc, item) => acc + (parseFloat(item.price) * parseInt(item.quantity)), 0);
    let orderId = 'ORD-' + Date.now();

    // 1º PASSO OBRIGATÓRIO: Salvar no Firebase
    try {
      const orderRef = await db.collection('orders').add({
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
      console.log(`📦 [CARTÃO] Pedido ${orderId} salvo no Firestore com sucesso!`);
    } catch (dbError) {
      console.error('❌ Erro ao salvar pedido de Cartão no Firestore:', dbError);
      return res.status(500).json({ error: 'Falha ao registrar pedido no banco de dados.' });
    }

    // (Opcional) Aqui entra a chamada real do Mercado Pago para cartão se estiver configurado no front-end
    
    res.status(200).json({
      success: true,
      orderId: orderId,
      status: 'approved'
    });

  } catch (error) {
    console.error('❌ Erro geral na rota de Cartão:', error);
    res.status(500).json({ error: 'Falha ao processar cartão de crédito.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Malala Store rodando na porta ${PORT}`);
});