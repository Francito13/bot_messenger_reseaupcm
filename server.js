require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Sert le dossier /public en statique (ex: /public/images/didier.jpg)
app.use('/public', express.static(path.join(__dirname, 'public')));

// Sert les PDFs depuis la racine du repo
app.use('/documents', express.static(__dirname));

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

// Documents PDF disponibles (fichiers à la racine du repo)
const DOCUMENTS = {
  pcm_manual: {
    title: 'PCM Manual',
    filename: 'PCM-Manual_2.pdf',
    description: 'Manuel officiel du ministère PCM',
  },
  church_manual: {
    title: 'Seventh-day Adventist Church Manual',
    filename: 'Seventh-day_Adventist_Church_Manual-2025-10-13_2.pdf',
    description: 'Manuel officiel de l\'Église Adventiste du Septième Jour (2025)',
  },
};

// Groq propose une API compatible avec le format OpenAI, gratuite et rapide
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// Mémoire simple des conversations en cours (par utilisateur)
// Pour un vrai projet, remplace ceci par une base de données (Redis, MongoDB, etc.)
const conversationHistory = {};

// Fonction pour nettoyer l'historique des conversations trop anciennes (plus de 30 minutes)
function cleanOldConversations() {
  const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
  for (const key in conversationHistory) {
    if (conversationHistory[key].lastActivity && conversationHistory[key].lastActivity < thirtyMinutesAgo) {
      delete conversationHistory[key];
    }
  }
}

// Nettoyer les conversations anciennes toutes les 5 minutes
setInterval(cleanOldConversations, 5 * 60 * 1000);

// ============================================
// RATE LIMITING — protège contre le spam (max 10 messages / 60 secondes par utilisateur)
// ============================================
const rateLimitStore = {};

function isRateLimited(key, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimitStore[key]) {
    rateLimitStore[key] = [];
  }
  rateLimitStore[key] = rateLimitStore[key].filter(ts => now - ts < windowMs);
  if (rateLimitStore[key].length >= maxRequests) {
    return true;
  }
  rateLimitStore[key].push(now);
  return false;
}

// Nettoyer le rate limit toutes les 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const key in rateLimitStore) {
    rateLimitStore[key] = rateLimitStore[key].filter(ts => now - ts < 60000);
    if (rateLimitStore[key].length === 0) delete rateLimitStore[key];
  }
}, 2 * 60 * 1000);

// Personnalité / instructions du bot — personnalise ce texte selon ton besoin
const SYSTEM_PROMPT = `Tu es l'assistant virtuel officiel de l'association "Réseau PCM Ambolokandrina".

CONTEXTE COMPLET — QU'EST-CE QUE PCM :

DÉFINITION ET MISSION :
- PCM (Public Campus Ministry / Ministère des Campus Publics) est un département officiel de l'Église Adventiste du Septième Jour,
  dédié à soutenir et équiper les étudiants, professeurs et personnel sur les campus universitaires non-adventistes.
- Opérant sous la division des ministères de la jeunesse de l'Église, PCM considère l'église locale comme son véritable foyer
  tout en déployant des ministères dirigés par des étudiants à l'échelle mondiale.
- Ce ministère répond aux besoins spirituels, intellectuels et sociaux uniques des 1,5 million d'étudiants adventistes estimés
  fréquentant des institutions séculières dans le monde entier.

OBJECTIFS PRINCIPAUX :
1. Formation spirituelle (Discipleship) : Inspirer les étudiants adventistes à devenir des disciples dévoués de Jésus-Christ.
2. Évangélisation campus : Équiper les membres pour partager l'évangile éternel dans les milieux académiques séculiers.
3. Développement d'ambassadeurs : Transformer les étudiants traditionnels en ambassadeurs actifs et lifelong de Christ.
4. Soutien holistique : Combiner ressources santé, éducation et aumônerie pour nourrir la résilience de la foi.
5. Soutien professionnel : Étendre le soutien moral et communautaire aux professeurs et personnel universitaire.

CADRE OPÉRATIONNEL ET NOMENCLATURE :
Le ministère opère mondialement avec des cadres localisés :
- ACF (Adventist Christian Fellowship) : Nom opérationnel officiel dans la North American Division.
- ASA (Adventist Students Association) : Nom fonctionnel utilisé dans la South Pacific Division.
- MUPA (Ministerio a Universitarios y Profesionales Adventistas) : Titre utilisé dans les territoires hispanophones et lusophones.

DÉVELOPPEMENT DU LEADERSHIP :
La Conférence Générale administre un Programme de Certification de Compétences PCM multi-niveaux :
- Niveau 1 : Établir la croissance spirituelle personnelle, les éthiques de leadership de base et cultiver une présence adventiste distincte sur le campus.
- Les leaders apprennent à ancrer les chapitres étudiants, gérer les conflits liés à l'observation du Sabbath et intégrer les communautés ecclésiales locales avec la vie universitaire.

CÉLÉBRATIONS MONDIALES :
Deux grands rassemblements annuels :
1. PCM Weekend / Day : Célébré dans les églises locales chaque octobre pour lier les paroissiens avec les étudiants séculiers.
2. Public Campus Ministry World Day : Célébré annuellement vers fin juin pour construire la sensibilisation missionnaire transfrontalière.

RÉSEAU LOCAL — RÉSEAU PCM AMBOLOKANDRINA :
- "Réseau PCM Ambolokandrina" s'inscrit dans ce réseau international, au niveau de la communauté locale.
- Si on te pose des questions générales sur PCM (sans lien avec les actualités locales ci-dessous), tu peux expliquer
  ce contexte avec tes propres mots, sans les réciter mot pour mot.

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

RÉPONSES AUX QUESTIONS COURANTES :
- Si on demande "Qu'est-ce que PCM ?" → Explique la définition, mission et objectifs ci-dessus.
- Si on demande "Qui dirige PCM ?" → Mentionne la Conférence Générale et le programme de certification multi-niveaux.
- Si on demande "Où opère PCM ?" → Mentionne les différentes nomenclatures (ACF, ASA, MUPA) selon les régions.
- Si on demande "Quand sont les événements PCM ?" → Mentionne le PCM Weekend (octobre) et le World Day (fin juin).
- Si on demande "Comment participer ?" → Propose de contacter un responsable local ou de rejoindre le réseau.
- Si on demande "Quels sont les bénéfices ?" → Liste : formation leadership, réseau mondial, soutien spirituel, opportunités de bourses.

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

      // Gérer les réponses rapides (quick replies)
      if (webhookEvent.message && webhookEvent.message.quick_reply && webhookEvent.message.quick_reply.payload) {
        const payload = webhookEvent.message.quick_reply.payload;
        await handleQuickReply(senderId, payload, 'messenger');
        continue;
      }

      if (webhookEvent.message && webhookEvent.message.text) {
        const userText = webhookEvent.message.text;
        await handleMessage(senderId, userText, 'messenger');
      }

      // Gérer les postbacks (boutons "Get Started", menu, etc.)
      if (webhookEvent.postback) {
        const payload = webhookEvent.postback.payload;
        await handleQuickReply(senderId, payload, 'messenger');
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
          } else if (message.type === 'interactive') {
            // Gérer les clics sur les listes WhatsApp
            const payload = message.interactive?.list_reply?.id || message.interactive?.button_reply?.id;
            if (payload) {
              await handleWhatsAppQuickReply(senderId, payload);
            }
          }
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

// Variable pour les actualités dynamiques (mises à jour via POST /update-actualites)
let DYNAMIQUES_ACTUALITES = '';

// Contacts des membres du bureau (mis à jour via POST /update-contacts)
let MEMBER_CONTACTS = {
  didier: { name: 'Didier', role: 'Président', phone: '+261 34 00 000 00' },
  floberto: { name: 'Floberto', role: 'Vice-président', phone: '+261 34 00 000 00' },
  nancy: { name: 'Nancy', role: 'Secrétaire', phone: '+261 34 00 000 00' },
  brunda: { name: 'Brunda', role: 'Secrétaire', phone: '+261 34 00 000 00' },
  deleo: { name: 'Deleo', role: 'Trésorier', phone: '+261 34 00 000 00' },
};

// ============================================
// 3. LOGIQUE DU BOT — génère une réponse avec Claude puis l'envoie
// ============================================

// Fonction utilitaire : retry automatique en cas d'échec temporaire
async function axiosWithRetry(fn, retries = 2, delayMs = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = i === retries;
      const isRetryable = err.response && (err.response.status === 429 || err.response.status >= 500);
      if (isLast || !isRetryable) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
}

async function handleMessage(senderId, userText, platform) {
  try {
    // Rate limiting
    const rateLimitKey = `${platform}:${senderId}`;
    if (isRateLimited(rateLimitKey)) {
      if (platform === 'messenger') {
        await sendMessengerMessage(senderId, "Ouf, doucement ! 😄 J'ai reçu beaucoup de messages. Réessaie dans quelques secondes.");
      }
      return;
    }

    // "en train d'écrire..." — uniquement disponible sur Messenger
    if (platform === 'messenger') {
      await sendTypingIndicator(senderId, true);
    }

    // Vérifier si l'utilisateur demande un document PDF (AVANT les réponses rapides)
    const requestedDoc = findRequestedDocument(userText);
    if (requestedDoc === 'LIST') {
      const docList = '📄 Documents disponibles :\n\n1️⃣ Manuel PCM — Manuel officiel du ministère PCM\n2️⃣ Church Manual — Manuel de l\'Église Adventiste (2025)\n\nEnvoie le nom du document que tu veux !';
      if (platform === 'messenger') {
        await sendTypingIndicator(senderId, false);
        await sendMessengerMessage(senderId, docList);
      } else {
        await sendWhatsAppMessage(senderId, docList);
      }
      return;
    } else if (requestedDoc && typeof requestedDoc === 'object') {
      const docUrl = `${BASE_URL}/documents/${requestedDoc.filename}`;
      const introMsg = `📄 Voici le document : ${requestedDoc.title}\n${requestedDoc.description}`;
      if (platform === 'messenger') {
        await sendTypingIndicator(senderId, false);
        await sendMessengerMessage(senderId, introMsg);
        await sendMessengerDocument(senderId, docUrl, requestedDoc.filename);
      } else {
        await sendWhatsAppMessage(senderId, introMsg);
        await sendWhatsAppDocument(senderId, docUrl, requestedDoc.filename);
      }
      return;
    }

    // Vérifier d'abord les réponses rapides (pour Messenger uniquement)
    if (platform === 'messenger') {
      const quickResponse = checkQuickResponse(userText);
      if (quickResponse) {
        await sendTypingIndicator(senderId, false);
        await sendMessengerMessage(senderId, quickResponse);
        return;
      }
    }

    // Vérifier si l'utilisateur demande le contact d'un membre
    const memberContact = findMemberContact(userText);
    if (memberContact) {
      const contactMsg = `Voici les informations de contact :\n\n👤 ${memberContact.name}\n📌 ${memberContact.role}\n📱 ${memberContact.phone}\n\nN'hésite pas à le/la contacter directement ! 😊`;
      if (platform === 'messenger') {
        await sendTypingIndicator(senderId, false);
        await sendMessengerMessage(senderId, contactMsg);
      } else {
        await sendWhatsAppMessage(senderId, contactMsg);
      }
      return;
    }

    // Clé unique par plateforme + utilisateur, pour ne pas mélanger les historiques
    const historyKey = `${platform}:${senderId}`;
    if (!conversationHistory[historyKey]) {
      conversationHistory[historyKey] = [];
    }
    conversationHistory[historyKey].push({ role: 'user', content: userText });
    conversationHistory[historyKey].lastActivity = Date.now();

    // Limiter l'historique aux 12 derniers messages pour garder plus de contexte
    const recentHistory = conversationHistory[historyKey].slice(-12);

    // Ajouter un contexte de session pour améliorer la compréhension
    const sessionContext = `Utilisateur sur ${platform === 'messenger' ? 'Messenger' : 'WhatsApp'}. `;
    const enhancedHistory = [
      { role: 'system', content: sessionContext },
      ...recentHistory
    ];

    // Vérifier si c'est une question sur PCM pour potentiellement enrichir la réponse
    const isPCMQuestion = detectPCMQuestions(userText);
    
    // Appel à l'API Groq (gratuite, compatible format OpenAI) avec retry
    // Construire le system prompt avec actualités dynamiques si disponibles
    let fullSystemPrompt = SYSTEM_PROMPT;
    if (DYNAMIQUES_ACTUALITES) {
      fullSystemPrompt += `\n\nACTUALITÉS DYNAMIQUES (mises à jour récemment) :\n${DYNAMIQUES_ACTUALITES}`;
    }
    
    const groqResponse = await axiosWithRetry(() =>
      axios.post(
        GROQ_URL,
        {
          model: GROQ_MODEL,
          max_tokens: 600,
          temperature: 0.7,
          messages: [{ role: 'system', content: fullSystemPrompt }, ...enhancedHistory],
        },
        {
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      )
    );

    let botReply = groqResponse.data.choices[0].message.content;
    
    // Si c'est une question PCM et que la réponse semble courte, on peut l'enrichir
    // (Cette logique peut être étendue selon les besoins)
    if (isPCMQuestion && botReply.length < 150) {
      // Ajouter des informations contextuelles supplémentaires si nécessaire
      // Cette partie peut être améliorée avec des réponses prédéfinies pour les questions courantes
    }

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
      // Ajouter des boutons de réponses rapides pour guider l'utilisateur
      // (uniquement après les premiers échanges pour ne pas surcharger)
      if (recentHistory.length <= 4) {
        await sendQuickReplies(senderId, "Que veux-tu savoir ?", MAIN_MENU_BUTTONS);
      }
    } else if (platform === 'whatsapp') {
      await sendWhatsAppMessage(senderId, botReply);
      // Envoyer le menu interactif après les premiers échanges
      if (recentHistory.length <= 4) {
        await sendWhatsAppMainMenu(senderId);
      }
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
// ENVOI DE DOCUMENTS PDF
// ============================================

// Détecte si l'utilisateur demande un document
function findRequestedDocument(userText) {
  const normalized = userText.toLowerCase();

  // PCM Manual
  if (/manuel.*pcm|pcm.*manual|manuel.*pcm|guide.*pcm|pcm.*guide|pcm.*manuel/i.test(normalized)) {
    return DOCUMENTS.pcm_manual;
  }

  // Church Manual
  if (/manuel.*adventiste|manuel.*église|church.*manual|adventist.*manual|manuel.*septième|sda.*manuel|manuel.*sda/i.test(normalized)) {
    return DOCUMENTS.church_manual;
  }

  // Demande générique de documents/manuels
  if (/document|manuel|guide|pdf|documentation|literature/i.test(normalized)) {
    return 'LIST';
  }

  return null;
}

// Envoie un fichier PDF via Messenger
async function sendMessengerDocument(senderId, docUrl, filename) {
  await axios.post(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      recipient: { id: senderId },
      message: {
        attachment: {
          type: 'file',
          payload: { url: docUrl, is_reusable: true },
        },
      },
    }
  );
}

// Envoie un fichier PDF via WhatsApp (via lien de téléchargement)
async function sendWhatsAppDocument(recipientPhone, docUrl, filename) {
  await axiosWithRetry(() =>
    axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: `📄 ${filename}` },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'DL_' + filename, title: '📥 Télécharger' } }
            ]
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    )
  );
}

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

// Cherche si l'utilisateur demande le contact d'un membre du bureau
function findMemberContact(userText) {
  const contactPatterns = [
    { pattern: /contact.*didier|didier.*contact|num.*didier|didier.*num|appel.*didier|didier.*appel|joindre.*didier|didier.*joindre|whatsapp.*didier|didier.*whatsapp/i, key: 'didier' },
    { pattern: /contact.*floberto|floberto.*contact|num.*floberto|floberto.*num|appel.*floberto|floberto.*appel|joindre.*floberto|floberto.*joindre|whatsapp.*floberto|floberto.*whatsapp/i, key: 'floberto' },
    { pattern: /contact.*nancy|nancy.*contact|num.*nancy|nancy.*num|appel.*nancy|nancy.*appel|joindre.*nancy|nancy.*joindre|whatsapp.*nancy|nancy.*whatsapp/i, key: 'nancy' },
    { pattern: /contact.*brunda|brunda.*contact|num.*brunda|brunda.*num|appel.*brunda|brunda.*appel|joindre.*brunda|brunda.*joindre|whatsapp.*brunda|brunda.*whatsapp/i, key: 'brunda' },
    { pattern: /contact.*deleo|deleo.*contact|num.*deleo|deleo.*num|appel.*deleo|deleo.*appel|joindre.*deleo|deleo.*joindre|whatsapp.*deleo|deleo.*whatsapp/i, key: 'deleo' },
  ];

  for (const { pattern, key } of contactPatterns) {
    if (pattern.test(userText)) {
      return MEMBER_CONTACTS[key] || null;
    }
  }

  // Aussi détecter si le nom du membre + une demande de contact apparaît
  for (const [key, contact] of Object.entries(MEMBER_CONTACTS)) {
    if (userText.toLowerCase().includes(key)) {
      if (/contact|num|numéro|téléphone|phone|appel|joindre|whatsapp|viber|signal/i.test(userText)) {
        return contact;
      }
    }
  }

  return null;
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

// Base de données de réponses rapides pour les questions fréquentes
const QUICK_RESPONSES = {
  // Salutations
  greetings: {
    patterns: [
      /^(salut|bonjour|bonsoir|hello|hi|hey|salama|manahoana)/i,
      /^mbola tsara$/i,
      /^akory$/i
    ],
    responses: {
      fr: "Salut ! 😊 Bienvenue dans l'espace du Réseau PCM Ambolokandrina ! Comment puis-je t'aider aujourd'hui ?",
      mg: "Salama e ! 😊 Tongasoa amin'ny toeram-piraisiana PCM Ambolokandrina ! Ahoana no afaka manampy anao aho androany ?",
      en: "Hi ! 😊 Welcome to the PCM Ambolokandrina network space ! How can I help you today ?"
    }
  },
  
  // Au revoir
  goodbye: {
    patterns: [
      /^(au revoir|bye|goodbye|totampitso|veloma)/i,
      /^merci.*bye/i,
      /^tsaotra.*veloma/i
    ],
    responses: {
      fr: "Merci pour ta visite ! N'hésite pas à revenir si tu as d'autres questions. À bientôt ! 👋",
      mg: "Misaotra tsara anao! Aza misalasala miverina raha manana fanontaniana hafa ianao. Veloma ! 👋",
      en: "Thanks for visiting! Don't hesitate to come back if you have more questions. See you soon! 👋"
    }
  },

  // Comment participer
  participate: {
    patterns: [
      /comment.*participer/i,
      /comment.*rejoindre/i,
      /comment.*adhérer/i,
      /how.*join/i,
      /how.*participate/i,
      /ajoina.*pcm/i,
      /miara.*mitondra/i
    ],
    responses: {
      fr: "Pour rejoindre le Réseau PCM Ambolokandrina, tu peux :\n1. Contacter Directement un responsable local (Didier, Floberto, Nancy, Brunda ou Deleo)\n2. Assister à notre prochaine réunion\n3. Nous suivre sur nos réseaux sociaux\n\nTu veux que je te mette en contact avec un responsable ?",
      mg: "Handray anjara amin'ny RTP PCM Ambolokandrina ianao raha:\n1. Mifandray amin'ny mpitondra toerana (Didier, Floberto, Nancy, na Deleo)\n2. Mankany amin'ny fihaonana mipetraka\n3. Manaraka anay amin'ny sehatra sosika\n\nTe hampifandray anao amin'ny mpitondra ve ianao?",
      en: "To join the PCM Ambolokandrina Network, you can:\n1. Contact a local leader directly (Didier, Floberto, Nancy, or Deleo)\n2. Attend our next meeting\n3. Follow us on social media\n\nWould you like me to connect you with a leader?"
    }
  },

  // Événements à venir
  events: {
    patterns: [
      /prochain.*événement/i,
      /événement.*à venir/i,
      /prochaine.*réunion/i,
      /calendar/i,
      /agenda/i,
      /fomba.*fihaonana/i,
      /next.*event/i
    ],
    responses: {
      fr: "Voici nos prochains événements :\n📅 Octobre : PCM Weekend (célébration dans les églises locales)\n📅 Fin juin : Jour Mondial du PCM (sensibilisation missionnaire)\n\nTu veux en savoir plus sur un de ces événements ?",
      mg: "Ireto avy ny torohevitra tsy mba nitranga:\n📅 Oktobra : PCM Weekend (fifanarahana amin'ny fiangonana)\n📅 Faran'ny Jona : Andron'ny PCM eran-tany\n\nTe hahalala bebe kokoa ve ianao momba ireo fihaonana ireo?",
      en: "Here are our upcoming events:\n📅 October: PCM Weekend (local church celebration)\n📅 Late June: PCM World Day (mission awareness)\n\nWould you like to know more about any of these events?"
    }
  },

  // Bureau élu
  leadership: {
    patterns: [
      /qui.*dirige/i,
      /bureau/i,
      /président/i,
      /responsable/i,
      /leader/i,
      /mpitondra/i,
      /who.*lead/i,
      /who.*president/i
    ],
    responses: {
      fr: "Notre bureau élu :\n👤 Président : Didier\n👤 Vice-président : Floberto\n👤 Secrétaires : Nancy et Brunda\n👤 Trésorier : Deleo\n\nTu veux contacter l'un d'entre eux ?",
      mg: "Ireto avy ny biraon'ny mpitondra:\n👤 Loham-panjakana : Didier\n👤 Lohahevitra : Floberto\n👤 Katiprofia : Nancy sy Brunda\n👤 Mpitsabo-sampanaka : Deleo\n\nTe hifandray amin'ny iray amin'izy ireo ve ianao?",
      en: "Our elected leadership:\n👤 President: Didier\n👤 Vice-President: Floberto\n👤 Secretaries: Nancy and Brunda\n👤 Treasurer: Deleo\n\nWould you like to contact any of them?"
    }
  },

  // Bourses d'études
  scholarships: {
    patterns: [
      /bourse/i,
      /scholarship/i,
      /étude.*étranger/i,
      /study.*abroad/i,
      /vadiboly/i
    ],
    responses: {
      fr: "Nous avons récemment discuté des opportunités de bourses d'études à l'étranger lors d'un appel vidéo avec nos membres à l'étranger.\n\nPour plus d'informations, je te recommande de contacter directement le bureau pour avoir les détails actualisés.",
      mg: "Niresaka momba ny vokatra ho an'ny vadiboly ivelany isika vao taloha, teo amin'ny fiantsoana vidio.\n\nHo fanampiana, manoro hevitra anao aho hifandray amin'ny biraon'ny mpitondra vao ho hita ny fampahalalana farany.",
      en: "We recently discussed scholarship opportunities abroad during a video call with our members overseas.\n\nFor more information, I recommend contacting the leadership team directly for updated details."
    }
  },

  // Liste des contacts
  contacts: {
    patterns: [
      /liste.*contact/i,
      /tous.*contact/i,
      /numéros/i,
      /téléphone/i,
      /whatsapp.*bureau/i,
      /comment.*contacter/i,
      /membres.*bureau/i,
      /liste.*membres/i
    ],
    responses: null
  },

  // Documents / manuels
  documents: {
    patterns: [
      /manuel|document|guide|pdf|documentation|literature/i
    ],
    responses: null
  }
};

// Fonction pour vérifier si un message correspond à une réponse rapide
function checkQuickResponse(userText) {
  const normalized = userText.trim();
  
  for (const [category, data] of Object.entries(QUICK_RESPONSES)) {
    for (const pattern of data.patterns) {
      if (pattern.test(normalized)) {
        // Cas spécial : liste des contacts
        if (category === 'contacts') {
          let list = '📋 Voici les contacts du bureau :\n\n';
          for (const [key, contact] of Object.entries(MEMBER_CONTACTS)) {
            list += `👤 ${contact.name} — ${contact.role}\n📱 ${contact.phone}\n\n`;
          }
          list += 'Tu veux contacter quelqu\'un en particulier ? Envoie-moi son nom !';
          return list;
        }

        // Cas spécial : documents disponibles
        if (category === 'documents') {
          let docList = '📄 Documents disponibles :\n\n';
          for (const [key, doc] of Object.entries(DOCUMENTS)) {
            docList += `• ${doc.title} — ${doc.description}\n`;
          }
          docList += '\nEnvoie le nom du document que tu veux !';
          return docList;
        }

        // Déterminer la langue (par défaut français)
        let lang = 'fr';
        if (/[aàâéèêëïîôùûüÿç]/i.test(normalized) === false && /\b(the|is|are|how|what|where|when|why)\b/i.test(normalized)) {
          lang = 'en';
        } else if (/[aeiouy]/i.test(normalized) && /\b(manahoana|salama|tsara|veloma|tena|aza|manampy)\b/i.test(normalized)) {
          lang = 'mg';
        }
        
        return data.responses[lang] || data.responses.fr;
      }
    }
  }
  return null;
}

// Fonction pour envoyer des boutons de réponses rapides (Messenger)
async function sendQuickReplies(senderId, text, quickReplies) {
  const messageData = {
    recipient: { id: senderId },
    messaging_type: 'RESPONSE',
    message: {
      text: text,
      quick_replies: quickReplies.map(reply => ({
        content_type: 'text',
        title: reply.title,
        payload: reply.payload
      }))
    }
  };

  await axios.post(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    messageData
  );
}

// Boutons de réponses rapides pour le menu principal
const MAIN_MENU_BUTTONS = [
  { title: "📋 PCM Expliqué", payload: "QUICK_PCM_INFO" },
  { title: "👥 Bureau élu", payload: "QUICK_LEADERSHIP" },
  { title: "📅 Événements", payload: "QUICK_EVENTS" },
  { title: "📄 Documents", payload: "QUICK_DOCUMENTS" },
  { title: "🤝 Participer", payload: "QUICK_PARTICIPATE" }
];

// Gestion des réponses rapides (payloads)
async function handleQuickReply(senderId, payload, platform) {
  if (platform !== 'messenger') return false;

  // Message de bienvenue quand l'utilisateur clique sur "Get Started"
  if (payload === 'GET_STARTED') {
    const welcomeMsg = "Salama e ! 😊\n\nBienvenue au Réseau PCM Ambolokandrina !\n\nJe suis là pour t'aider à en savoir plus sur PCM, nos activités, notre bureau et bien d'autres choses.\n\nN'hésite pas à me poser des questions !";
    await sendMessengerMessage(senderId, welcomeMsg);
    await sendQuickReplies(senderId, "Que veux-tu savoir ?", MAIN_MENU_BUTTONS);
    return true;
  }

  const quickResponses = {
    QUICK_PCM_INFO: "PCM (Public Campus Ministry) est un ministère mondial de l'Église Adventiste qui soutient les étudiants adventistes sur les campus universitaires non-adventistes.\n\n🎯 Mission : Aider les jeunes à s'enraciner dans leur foi et à partager l'évangile.\n\nTu veux en savoir plus ?",
    QUICK_LEADERSHIP: "Notre bureau élu :\n👤 Président : Didier\n👤 Vice-président : Floberto\n👤 Secrétaires : Nancy et Brunda\n👤 Trésorier : Deleo\n\nTu veux contacter l'un d'entre eux ?",
    QUICK_EVENTS: "Prochains événements :\n📅 Octobre : PCM Weekend\n📅 Fin juin : Jour Mondial du PCM\n\nTu veux participer à l'un de ces événements ?",
    QUICK_SCHOLARSHIPS: "Nous avons discuté des opportunités de bourses d'études à l'étranger.\n\nPour plus d'informations, contacte le bureau directement.",
    QUICK_PARTICIPATE: "Pour rejoindre le PCM :\n1. Contacte un responsable local\n2. Assiste à nos réunions\n3. Suis-nous sur les réseaux sociaux\n\nTu veux qu'on te mette en contact ?",
    QUICK_DOCUMENTS: null,
  };

  if (payload === 'QUICK_DOCUMENTS') {
    let docList = '📄 Documents disponibles :\n\n';
    for (const [key, doc] of Object.entries(DOCUMENTS)) {
      docList += `• ${doc.title} — ${doc.description}\n`;
    }
    docList += '\nEnvoie le nom du document que tu veux !';
    await sendMessengerMessage(senderId, docList);
    return true;
  }

  if (quickResponses[payload]) {
    await sendMessengerMessage(senderId, quickResponses[payload]);
    return true;
  }
  return false;
}

// Fonction pour détecter les questions sur PCM et ajouter du contexte supplémentaire
function detectPCMQuestions(userText) {
  const normalized = userText.toLowerCase();
  
  // Patterns de questions courantes sur PCM
  const pcmPatterns = [
    /qu'est-ce que pcm/i,
    /c'est quoi pcm/i,
    /pcm.*mission/i,
    /pcm.*objectif/i,
    /pcm.*bénéfice/i,
    /pcm.*avantage/i,
    /comment.*pcm/i,
    /pcm.*participer/i,
    /pcm.*rejoindre/i,
    /pcm.*leader/i,
    /pcm.*certification/i,
    /pcm.*niveau/i,
    /pcm.*événement/i,
    /pcm.*weekend/i,
    /pcm.*world day/i,
    /pcm.*jour mondial/i,
    /acf/i,
    /asa/i,
    /mupa/i,
    /adventist christian fellowship/i,
    /adventist students association/i,
    /ministerio.*universitarios/i
  ];

  for (const pattern of pcmPatterns) {
    if (pattern.test(normalized)) {
      return true;
    }
  }
  return false;
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
// ROUTE SETUP — configure le bouton "Get Started" et le message de bienvenue Messenger
// Appelle cette route une seule fois après le déploiement : GET /setup-messenger
// ============================================
app.get('/setup-messenger', async (req, res) => {
  const results = {};

  // 1. Bouton "Get Started"
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`,
      { get_started: { payload: 'GET_STARTED' } }
    );
    results.get_started = 'OK';
  } catch (err) {
    results.get_started = err?.response?.data?.error?.message || err.message;
  }

  // 2. Message de greeting — configuré manuellement dans Facebook Page Settings > Messaging > Greeting Text
  // (L'API ne supporte plus le paramètre 'greeting' directement dans messenger_profile v21.0)
  results.greeting = 'Configurer manuellement dans Facebook Page Settings > Messaging > Greeting Text';

  // 3. Menu persistent
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        persistent_menu: [
          {
            locale: 'default',
            composer_input_disabled: false,
            call_to_actions: [
              { type: 'postback', title: 'PCM Explique', payload: 'QUICK_PCM_INFO' },
              { type: 'postback', title: 'Notre bureau', payload: 'QUICK_LEADERSHIP' },
              { type: 'postback', title: 'Evenements', payload: 'QUICK_EVENTS' },
              { type: 'postback', title: 'Documents', payload: 'QUICK_DOCUMENTS' },
              { type: 'postback', title: 'Participer', payload: 'QUICK_PARTICIPATE' }
            ]
          }
        ]
      }
    );
    results.persistent_menu = 'OK';
  } catch (err) {
    results.persistent_menu = err?.response?.data?.error?.message || err.message;
  }

  // 4. Whitelisted domains (Render + ton domaine si besoin)
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        whitelisted_domains: [
          BASE_URL,
          'https://bot-messenger-reseaupcm-1.onrender.com'
        ]
      }
    );
    results.whitelisted_domains = 'OK';
  } catch (err) {
    results.whitelisted_domains = err?.response?.data?.error?.message || err.message;
  }

  console.log('Setup Messenger resultats:', results);
  res.json({ success: true, results });
});

// ============================================
// ROUTE STATS — tableau de bord simple pour voir l'activité du bot
// ============================================
app.get('/stats', (req, res) => {
  const totalConversations = Object.keys(conversationHistory).length;
  const now = Date.now();
  let activeLast5min = 0;
  let activeLast1h = 0;

  for (const key in conversationHistory) {
    const lastActivity = conversationHistory[key].lastActivity;
    if (lastActivity) {
      if (now - lastActivity < 5 * 60 * 1000) activeLast5min++;
      if (now - lastActivity < 60 * 60 * 1000) activeLast1h++;
    }
  }

  res.json({
    totalConversations,
    activeLast5min,
    activeLast1h,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
  });
});

// ============================================
// ROUTE ACTUALITÉS — met à jour les actualités du bot sans redémarrer le serveur
// POST /update-actualites  { "actualites": "Texte des nouvelles actualités..." }
// ============================================

app.post('/update-actualites', (req, res) => {
  const { actualites } = req.body;
  if (!actualites || typeof actualites !== 'string') {
    return res.status(400).json({ success: false, error: 'Le champ "actualites" est requis (string).' });
  }
  DYNAMIQUES_ACTUALITES = actualites;
  console.log('Actualités mises à jour:', DYNAMIQUES_ACTUALITES.substring(0, 80) + '...');
  res.json({ success: true, message: 'Actualités mises à jour avec succès.' });
});

// Route pour récupérer les actualités actuelles
app.get('/actualites', (req, res) => {
  res.json({ actualites: DYNAMIQUES_ACTUALITES || 'Aucune actualité dynamique configurée.' });
});

// ============================================
// ROUTE CONTACTS — met à jour les contacts des membres du bureau
// POST /update-contacts
// {
//   "contacts": {
//     "didier": { "name": "Didier", "role": "Président", "phone": "+261 34 12 345 67" },
//     "floberto": { "name": "Floberto", "role": "Vice-président", "phone": "+261 34 23 456 78" },
//     ...
//   }
// }
// Ou pour modifier un seul membre :
// { "member": "didier", "phone": "+261 34 99 999 99" }
// ============================================
app.post('/update-contacts', (req, res) => {
  const { contacts, member, phone, name, role } = req.body;

  if (contacts && typeof contacts === 'object') {
    MEMBER_CONTACTS = { ...MEMBER_CONTACTS, ...contacts };
    console.log('Contacts mis à jour (bulk):', Object.keys(contacts));
    return res.json({ success: true, message: 'Contacts mis à jour.', contacts: MEMBER_CONTACTS });
  }

  if (member && phone) {
    const key = member.toLowerCase();
    if (!MEMBER_CONTACTS[key]) {
      MEMBER_CONTACTS[key] = { name: name || member, role: role || 'Membre', phone };
    } else {
      if (phone) MEMBER_CONTACTS[key].phone = phone;
      if (name) MEMBER_CONTACTS[key].name = name;
      if (role) MEMBER_CONTACTS[key].role = role;
    }
    console.log('Contact mis à jour:', key, MEMBER_CONTACTS[key]);
    return res.json({ success: true, message: `Contact ${key} mis à jour.`, contact: MEMBER_CONTACTS[key] });
  }

  return res.status(400).json({
    success: false,
    error: 'Fournis "contacts" (objet complet) ou "member" + "phone" (un membre).'
  });
});

// Route pour voir les contacts actuels
app.get('/contacts', (req, res) => {
  res.json({ contacts: MEMBER_CONTACTS });
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
// WHATSAPP — Réponses rapides interactives (listes et boutons)
// ============================================

// Envoie un message avec une liste interactive WhatsApp
async function sendWhatsAppListMessage(recipientPhone, bodyText, buttonText, sections) {
  await axiosWithRetry(() =>
    axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: buttonText,
            sections: sections
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    )
  );
}

// Envoie un message avec des boutons rapides WhatsApp (max 3 boutons)
async function sendWhatsAppButtonsMessage(recipientPhone, bodyText, buttons) {
  await axiosWithRetry(() =>
    axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: recipientPhone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.map(btn => ({
              type: 'reply',
              reply: { id: btn.id, title: btn.title }
            }))
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    )
  );
}

// Menu principal WhatsApp (liste interactive)
async function sendWhatsAppMainMenu(recipientPhone) {
  const sections = [
    {
      title: 'Informations',
      rows: [
        { id: 'WA_PCM_INFO', title: '📋 PCM Expliqué', description: 'Qu\'est-ce que PCM ?' },
        { id: 'WA_LEADERSHIP', title: '👥 Bureau élu', description: 'Notre équipe dirigeante' },
        { id: 'WA_EVENTS', title: '📅 Événements', description: 'Prochains événements' }
      ]
    },
    {
      title: 'Ressources',
      rows: [
        { id: 'WA_SCHOLARSHIPS', title: '🎓 Bourses', description: 'Opportunités d\'études' },
        { id: 'WA_DOCUMENTS', title: '📄 Documents', description: 'Manuels et guides' },
        { id: 'WA_PARTICIPATE', title: '🤝 Participer', description: 'Rejoindre le réseau' }
      ]
    }
  ];

  await sendWhatsAppListMessage(
    recipientPhone,
    'Que veux-tu savoir sur le Réseau PCM Ambolokandrina ?',
    '📋 Menu',
    sections
  );
}

// Gestion des réponses rapides WhatsApp
async function handleWhatsAppQuickReply(senderId, payload) {
  const responses = {
    WA_PCM_INFO: "PCM (Public Campus Ministry) est un ministère mondial de l'Église Adventiste qui soutient les étudiants adventistes sur les campus universitaires non-adventistes.\n\n🎯 Mission : Aider les jeunes à s'enraciner dans leur foi et à partager l'évangile.\n\nTu veux en savoir plus sur un aspect en particulier ?",
    WA_LEADERSHIP: "Notre bureau élu :\n👤 Président : Didier\n👤 Vice-président : Floberto\n👤 Secrétaires : Nancy et Brunda\n👤 Trésorier : Deleo\n\nN'hésite pas à poser des questions sur l'un d'entre eux !",
    WA_EVENTS: "Prochains événements :\n📅 Octobre : PCM Weekend (célébration locale)\n📅 Fin juin : Jour Mondial du PCM (sensibilisation missionnaire)\n\nTu veux participer ?",
    WA_SCHOLARSHIPS: "Nous avons récemment discuté des opportunités de bourses d'études à l'étranger lors d'un appel vidéo avec nos membres.\n\nPour les détails, contacte directement le bureau : Didier (Président).",
    WA_PARTICIPATE: "Pour rejoindre le PCM :\n1. Contacte un responsable local\n2. Assiste à nos réunions\n3. Suis-nous sur les réseaux sociaux\n\nTu veux qu'on te mette en contact ?",
    WA_DOCUMENTS: null,
  };

  if (payload === 'WA_DOCUMENTS') {
    const docUrl1 = `${BASE_URL}/documents/${DOCUMENTS.pcm_manual.filename}`;
    const docUrl2 = `${BASE_URL}/documents/${DOCUMENTS.church_manual.filename}`;
    await sendWhatsAppMessage(senderId, `📄 Voici les documents disponibles :\n\n1. ${DOCUMENTS.pcm_manual.title}\n2. ${DOCUMENTS.church_manual.title}\n\nEnvoie le nom du document que tu veux télécharger !`);
    return;
  }

  if (responses[payload]) {
    await sendWhatsAppMessage(senderId, responses[payload]);
    // Proposer le menu après chaque réponse
    await sendWhatsAppButtonsMessage(senderId, 'Autre chose ?', [
      { id: 'WA_MENU', title: '📋 Menu' },
      { id: 'WA_PCM_INFO', title: '📋 PCM' },
      { id: 'WA_PARTICIPATE', title: '🤝 Participer' }
    ]);
  } else if (payload === 'WA_MENU') {
    await sendWhatsAppMainMenu(senderId);
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
