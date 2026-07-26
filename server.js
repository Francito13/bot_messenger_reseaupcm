require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Sert le dossier /public en statique (ex: /public/images/didier.jpg)
app.use('/public', express.static(path.join(__dirname, 'public')));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const PORT = process.env.PORT || 3000;

// L'URL publique de ton serveur Render (nécessaire pour construire les liens d'images)
// Exemple : https://bot-messenger-reseaupcm-1.onrender.com
const BASE_URL = process.env.BASE_URL || 'https://bot-messenger-reseaupcm-1.onrender.com';

// Mapping mot-clé (en minuscule) -> fichier image dans /public/images
// Ajoute/modifie librement cette liste selon les photos que tu as
const MEMBER_PHOTOS = {
  didier: 'didier.jpg',
  floberto: 'floberto.jpg',
  nancy: 'nancy.jpg',
  brunda: 'brunda.jpg',
  deleo: 'deleo.jpg',
};

// Groq propose une API compatible avec le format OpenAI, gratuite et rapide
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Mémoire simple des conversations en cours (par utilisateur)
// Pour un vrai projet, remplace ceci par une base de données (Redis, MongoDB, etc.)
const conversationHistory = {};

// Personnalité / instructions du bot — personnalise ce texte selon ton besoin
const SYSTEM_PROMPT = `Tu es l'assistant virtuel officiel de l'association "Réseau PCM Ambolokandrina".

IDENTITÉ :
- Tu représentes cette association, mais tu parles comme un membre proche de la communauté, pas comme une institution froide.
- Si on te demande qui tu es, présente-toi simplement comme l'assistant de "Réseau PCM Ambolokandrina", avec chaleur.

LANGUES :
- Tu maîtrises le malagasy, le français et l'anglais.
- Réponds TOUJOURS dans la même langue que celle utilisée par l'utilisateur dans son dernier message.
- Si l'utilisateur mélange plusieurs langues (courant en malagasy familier, ex: mélange malagasy/français),
  réponds dans ce même style naturel plutôt que de forcer une seule langue.
- Si la langue n'est pas claire, réponds en malagasy par défaut (langue principale de la communauté).

STYLE :
- Sois chaleureux, proche et naturel — comme un ami de la communauté qui aide, pas comme un service client formel.
- Tutoie la personne (ou utilise le registre familier équivalent en malagasy : "ianao", pas "ianareo" de politesse).
- Utilise volontiers des expressions courantes et amicales (ex: "Salama e!", "Miarahaba!", "Tsara be izany!").
- Un emoji de temps en temps est bienvenu pour garder une ambiance conviviale, sans en abuser.
- Reste concis et utile : pas de discours long, va droit au but avec gentillesse.
- Si tu ne connais pas une information précise sur l'association (horaires, événements, contacts...),
  dis-le honnêtement et simplement, et propose de rediriger vers un responsable si besoin.

ACTUALITÉS DE L'ASSOCIATION (à jour au ${new Date().toLocaleDateString('fr-FR')}) :
- Élections du bureau tenues aujourd'hui, résultats votés :
  • Président : Didier
  • Vice-président : Floberto
  • Secrétaires : Nancy et Brunda
  • Trésorerie : Deleo
- Un appel vidéo a eu lieu avec les membres vivant à l'étranger pour discuter de l'opportunité de bourses d'études à l'extérieur.
- La journée s'est terminée par un "Fiarahamisakafo" (repas partagé communautaire).
- Si l'utilisateur pose une question sur ces actualités, partage ces informations naturellement dans la conversation.
- Si tu réponds en malagasy, traduis aussi le contenu de ces actualités en malagasy (ne les laisse pas en français).

PROPOSITIONS DE THÈME EN FIN DE CONVERSATION :
- Quand tu sens que la conversation touche à sa fin (l'utilisateur dit merci, au revoir, n'a plus de question, ou la discussion se conclut naturellement),
  termine ta réponse en proposant 2 à 3 thèmes de discussion liés aux actualités ci-dessus (ex: "Veux-tu qu'on parle des bourses à l'étranger ?", "Un mot sur le nouveau bureau élu ?").
- Adapte ces propositions à la langue de la conversation (malagasy, français ou anglais).
- Ne propose pas de thèmes à chaque message — seulement en fin de conversation.`;

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

    // Détecte si un nom de membre est mentionné dans le message de l'utilisateur
    // (on regarde le message utilisateur, pas la réponse de l'IA, pour rester fiable)
    const mentionedPhotos = findMentionedMemberPhotos(userText);

    if (platform === 'messenger') {
      await sendTypingIndicator(senderId, false);
      await sendMessengerMessage(senderId, botReply);
      // Envoie la/les photo(s) des membres mentionnés, après le texte
      for (const filename of mentionedPhotos) {
        await sendMessengerImage(senderId, `${BASE_URL}/public/images/${filename}`);
      }
    } else if (platform === 'whatsapp') {
      await sendWhatsAppMessage(senderId, botReply);
      // Note : l'envoi d'image WhatsApp suit un format différent (non implémenté ici)
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

// Envoie une image via son URL publique (ex: photo d'un membre)
async function sendMessengerImage(senderId, imageUrl) {
  await axios.post(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: 'image',
          payload: { url: imageUrl, is_reusable: true },
        },
      },
    }
  );
}

// Cherche dans le message utilisateur les noms de membres connus (insensible à la casse/accents)
// et renvoie la liste des fichiers image correspondants, sans doublons
function findMentionedMemberPhotos(userText) {
  const normalized = userText
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // enlève les accents

  const matches = [];
  for (const [name, filename] of Object.entries(MEMBER_PHOTOS)) {
    if (normalized.includes(name)) {
      matches.push(filename);
    }
  }
  return matches;
}

// ============================================
// ROUTE DE DEBUG TEMPORAIRE — à supprimer une fois le problème résolu
// Permet de vérifier ce que le serveur voit réellement sur le disque
// ============================================
app.get('/debug-images', (req, res) => {
  const fs = require('fs');
  const imagesDir = path.join(__dirname, 'public', 'images');
  try {
    const files = fs.readdirSync(imagesDir);
    res.json({ imagesDir, files });
  } catch (err) {
    res.status(500).json({ imagesDir, error: err.message });
  }
});

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
