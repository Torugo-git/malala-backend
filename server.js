const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { MercadoPagoConfig, Payment } = require('mercadopago');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 1. INICIALIZAÇÃO DO FIREBASE
let db = null;

try {
  let serviceAccount;
  
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    console.log('☁️ Firebase: Lendo credenciais da Variável de Ambiente (Render)');
  } else {
    serviceAccount = require('./serviceAccountKey.json');
    console.log('💻 Firebase: Lendo credenciais do arquivo local');
  }

  initializeApp({
    credential: cert(serviceAccount)
  });
  
  db = getFirestore();
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

// FUNÇÃO DE VALIDAÇÃO DUPLA DE ESTOQUE
async function validateStockBeforeCheckout(requestedItems) {
    if (!db) throw new Error("Banco de dados indisponível.");
    
    const docRef = db.collection('malala_store').doc('catalog');
    const docSnap = await docRef.get();
    
    if (!docSnap.exists || !docSnap.data().products) {
        throw new Error("Catálogo não encontrado na nuvem.");
    }
    
    const catalog = docSnap.data().products;
    
    for (let item of requestedItems) {
        const productInDb = catalog.find(p => String(p.id) === String(item.id));
        if (!productInDb) {
            return { valid: false, error: `Produto "${item.title}" não existe mais no catálogo.` };
        }
        if (productInDb.stock < item.quantity) {
            return { 
                valid: false, 
                error: `O produto "${item.title}" esgotou ou não tem a quantidade solicitada (Estoque atual: ${productInDb.stock}).` 
            };
        }
    }
    return { valid: true };
}

// ROTA 1: PIX
app.post('/api/payments/pix', async (req, res) => {
  try {
    const { items, payer, shippingAddress } = req.body;
    if (!db) return res.status(500).json({ error: 'Erro interno: Banco de dados desconectado.' });

    const stockValidation = await validateStockBeforeCheckout(items);
    if (!stockValidation.valid) {
        return res.status(409).json({ error: stockValidation.error });
    }

    const totalAmount = items.reduce((acc, item) => acc + (parseFloat(item.price) * parseInt(item.quantity)), 0);
    let orderId = 'ORD-' + Date.now();

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
        createdAt: FieldValue.serverTimestamp()
      });
      orderId = orderRef.id;
    } catch (dbError) {
      return res.status(500).json({ error: 'Falha ao registrar pedido no banco de dados.' });
    }

    const backendUrl = process.env.RENDER_EXTERNAL_URL || `https://${req.get('host')}`;
    
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
        notification_url: `${backendUrl}/api/webhooks/mercadopago`
      }
    };

    const paymentResponse = await paymentClient.create(paymentData);
    const pixInfo = paymentResponse.point_of_interaction.transaction_data;

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
        if (!db) return res.status(500).json({ error: 'Erro interno: Banco de dados desconectado.' });

        const stockValidation = await validateStockBeforeCheckout(items);
        if (!stockValidation.valid) {
            return res.status(409).json({ error: stockValidation.error });
        }

        const totalAmount = items.reduce((acc, item) => acc + (parseFloat(item.price) * parseInt(item.quantity)), 0);
        let orderId = 'ORD-' + Date.now();

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
            createdAt: FieldValue.serverTimestamp()
          });
          orderId = orderRef.id;

          // --- ADICIONAR ESTE BLOCO PARA BAIXAR O ESTOQUE NO FIRESTORE ---
          const catalogRef = db.collection('malala_store').doc('catalog');
          const catalogSnap = await catalogRef.get();
          
          if (catalogSnap.exists && catalogSnap.data().products) {
            let catProducts = catalogSnap.data().products;
            let changed = false;

            items.forEach(item => {
              const p = catProducts.find(x => String(x.id) === String(item.id));
              if (p && p.stock !== undefined) {
                p.stock = Math.max(0, p.stock - item.quantity);
                changed = true;
              }
            });

            if (changed) {
              await catalogRef.update({
                products: catProducts,
                updatedAt: FieldValue.serverTimestamp()
              });
            }
          }
          // -------------------------------------------------------------

          console.log(`📦 [CARTÃO] Pedido ${orderId} salvo, aprovado e estoque reduzido com sucesso!`);
        } catch (dbError) {
          return res.status(500).json({ error: 'Falha ao registrar pedido no banco de dados.' });
        }

        res.status(200).json({ success: true, orderId: orderId, status: 'approved' });
      } catch (error) {
        console.error('❌ Erro geral na rota de Cartão:', error);
        res.status(500).json({ error: 'Falha ao processar cartão de crédito.' });
      }
    });

// ROTA 3: WEBHOOK MERCADO PAGO
app.post('/api/webhooks/mercadopago', async (req, res) => {
  res.status(200).send('OK');

  try {
    const { type, data } = req.body;
    
    if (type === 'payment' && data && data.id) {
      const paymentId = data.id;
      const paymentInfo = await paymentClient.get({ id: paymentId });
      
      const orderId = paymentInfo.external_reference;
      const status = paymentInfo.status;

      if (!orderId || !db) return;

      const orderRef = db.collection('orders').doc(orderId);
      const orderSnap = await orderRef.get();

      if (orderSnap.exists) {
        const orderData = orderSnap.data();
        
        if (status === 'approved' && orderData.status !== 'Pago') {
          await orderRef.update({
            status: 'Pago',
            updatedAt: FieldValue.serverTimestamp()
          });

          const catalogRef = db.collection('malala_store').doc('catalog');
          const catalogSnap = await catalogRef.get();
          
          if (catalogSnap.exists && catalogSnap.data().products) {
            let catProducts = catalogSnap.data().products;
            let changed = false;

            orderData.items.forEach(item => {
              const p = catProducts.find(x => String(x.id) === String(item.id));
              if (p && p.stock !== undefined) {
                p.stock = Math.max(0, p.stock - item.quantity);
                changed = true;
              }
            });

            if (changed) {
              await catalogRef.update({
                products: catProducts,
                updatedAt: FieldValue.serverTimestamp()
              });
              console.log(`✅ [WEBHOOK] Pedido ${orderId} aprovado e stock reduzido!`);
            }
          }

        } else if (status === 'cancelled' || status === 'rejected') {
           await orderRef.update({
            status: 'Cancelado',
            updatedAt: FieldValue.serverTimestamp()
          });
        }
      }
    }
  } catch (error) {
    console.error('❌ Erro no processamento do Webhook:', error);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Malala Store rodando na porta ${PORT}`);
});