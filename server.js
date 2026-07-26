require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const PORT = process.env.PORT || 3000;

// Groq propose une API compatible avec le format OpenAI, gratuite et rapide
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Mémoire simple des conversations en cours (par utilisateur)
// Pour un vrai projet, remplace ceci par une base de données (Redis, MongoDB, etc.)
const conversationHistory = {};

// Personnalité / instructions du bot — personnalise ce texte selon ton besoin
const SYSTEM_PROMPT = `Tu es l'assistant virtuel officiel de notre page Facebook.
Réponds de façon amicale, concise et utile. Réponds toujours en français
sauf si l'utilisateur écrit dans une autre langue. Si tu ne connais pas
une information précise sur l'entreprise, dis-le honnêtement au lieu d'inventer.`;

// ============================================
// 1. VÉRIFICATION DU WEBHOOK (GET)
// Meta appelle cette route une seule fois pour confirmer que le serveur t'appartient
// ============================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook vérifié avec succès ✅');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ============================================
// 2. RÉCEPTION DES MESSAGES (POST)
// Meta envoie ici chaque message reçu par ta Page
// ============================================
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    // ----- Messages venant de MESSENGER -----
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      const webhookEvent = entry.messaging[0];
      const senderId = webhookEvent.sender.id;

      if (webhookEvent.message && webhookEvent.message.text) {
        const userText = webhookEvent.message.text;
        await handleMessage(senderId, userText, 'messenger');
      }
    }
  } else if (body.object === 'whatsapp_business_account') {
    // ----- Messages venant de WHATSAPP -----
    res.status(200).send('EVENT_RECEIVED');

    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const messages = change.value?.messages;
        if (messages && messages.length > 0) {
          const message = messages[0];
          const senderId = message.from; // numéro de téléphone de l'expéditeur
          if (message.type === 'text') {
            await handleMessage(senderId, message.text.body, 'whatsapp');
          }
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

// ============================================
// 3. LOGIQUE DU BOT — génère une réponse avec Claude puis l'envoie
// ============================================
async function handleMessage(senderId, userText, platform) {
  try {
    // "en train d'écrire..." — uniquement disponible sur Messenger
    if (platform === 'messenger') {
      await sendTypingIndicator(senderId, true);
    }

    // Clé unique par plateforme + utilisateur, pour ne pas mélanger les historiques
    const historyKey = `${platform}:${senderId}`;
    if (!conversationHistory[historyKey]) {
      conversationHistory[historyKey] = [];
    }
    conversationHistory[historyKey].push({ role: 'user', content: userText });

    // Limiter l'historique aux 10 derniers messages pour rester léger
    const recentHistory = conversationHistory[historyKey].slice(-10);

    // Appel à l'API Groq (gratuite, compatible format OpenAI)
    const groqResponse = await axios.post(
      GROQ_URL,
      {
        model: GROQ_MODEL,
        max_tokens: 500,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...recentHistory],
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const botReply = groqResponse.data.choices[0].message.content;

    conversationHistory[historyKey].push({ role: 'assistant', content: botReply });

    if (platform === 'messenger') {
      await sendTypingIndicator(senderId, false);
      await sendMessengerMessage(senderId, botReply);
    } else if (platform === 'whatsapp') {
      await sendWhatsAppMessage(senderId, botReply);
    }
  } catch (error) {
    console.error('Erreur handleMessage:', error?.response?.data || error.message);
    const errMsg = "Désolé, une erreur est survenue. Réessaie dans un instant 🙏";
    if (platform === 'messenger') {
      await sendMessengerMessage(senderId, errMsg);
    } else if (platform === 'whatsapp') {
      await sendWhatsAppMessage(senderId, errMsg);
    }
  }
}

// ============================================
// 4. ENVOI D'UN MESSAGE VIA L'API MESSENGER
// ============================================
async function sendMessengerMessage(senderId, text) {
  // Messenger limite chaque message à 2000 caractères : on découpe si besoin
  const chunks = text.match(/[\s\S]{1,1900}/g) || [text];

  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderId },
        message: { text: chunk },
      }
    );
  }
}

// ============================================
// 4bis. ENVOI D'UN MESSAGE VIA L'API WHATSAPP
// ============================================
async function sendWhatsAppMessage(recipientPhone, text) {
  // WhatsApp limite chaque message à 4096 caractères : on découpe si besoin
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];

  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'text',
        text: { body: chunk },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
  }
}

// Indicateur "en train d'écrire..."
async function sendTypingIndicator(senderId, isTyping) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: senderId },
        sender_action: isTyping ? 'typing_on' : 'typing_off',
      }
    );
  } catch (e) {
    // non bloquant si ça échoue
  }
}

// ============================================
// Route racine pour vérifier que le serveur tourne
// ============================================
app.get('/', (req, res) => {
  res.send('Le bot Messenger est en ligne ✅');
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
