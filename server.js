require('dotenv').config();
const path = require('path');
const fs = require('fs');
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
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'pcm-admin-secret-2025';
const PORT = process.env.PORT || 3000;

const BASE_URL = process.env.BASE_URL || 'https://bot-messenger-reseaupcm-1.onrender.com';
const WEBSITE_URL = 'https://pcm.ifree.page/';

const MEMBER_PHOTOS = {
  didier: 'didier.jpg',
  floberto: 'floberto.jpg',
  nancy: 'nancy.jpg',
  brunda: 'brunda.jpg',
  deleo: 'deleo.jpg',
};

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

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ============================================
// BASE DE DONNÉES JSON — persiste les conversations et préférences
// ============================================
const DB_PATH = path.join(__dirname, 'bot-data.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Erreur chargement DB:', e.message);
  }
  return { conversations: {}, userPreferences: {}, broadcastHistory: [] };
}

function saveDB() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(database, null, 2));
  } catch (e) {
    console.error('Erreur sauvegarde DB:', e.message);
  }
}

let database = loadDB();
const conversationHistory = database.conversations || {};
const userPreferences = database.userPreferences || {};

// Sauvegarder la DB toutes les 2 minutes
setInterval(saveDB, 2 * 60 * 1000);

// Nettoyer les conversations > 30 minutes
function cleanOldConversations() {
  const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
  let changed = false;
  for (const key in conversationHistory) {
    if (conversationHistory[key].lastActivity && conversationHistory[key].lastActivity < thirtyMinutesAgo) {
      delete conversationHistory[key];
      changed = true;
    }
  }
  if (changed) saveDB();
}
setInterval(cleanOldConversations, 5 * 60 * 1000);

// ============================================
// SÉCURITÉ — Middleware API key pour les routes admin
// ============================================
function adminAuth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== ADMIN_API_KEY) {
    return res.status(403).json({ success: false, error: 'Clé API invalide. Ajoute Header: x-api-key' });
  }
  next();
}

// ============================================
// RATE LIMITING
// ============================================
const rateLimitStore = {};

function isRateLimited(key, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimitStore[key]) rateLimitStore[key] = [];
  rateLimitStore[key] = rateLimitStore[key].filter(ts => now - ts < windowMs);
  if (rateLimitStore[key].length >= maxRequests) return true;
  rateLimitStore[key].push(now);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const key in rateLimitStore) {
    rateLimitStore[key] = rateLimitStore[key].filter(ts => now - ts < 60000);
    if (rateLimitStore[key].length === 0) delete rateLimitStore[key];
  }
}, 2 * 60 * 1000);

// ============================================
// SYSTÈME D'URGENCE — détecte les messages urgents
// ============================================
function detectUrgency(userText) {
  const urgencyPatterns = [
    /urgent|aidez[- ]?moi|help|secours|problème|problème|danger|dépression|suicide|mal-être|souffre|detresse|détresse|pleure|triste|perdu|abandon|crise/i,
    /azafady|manampy|fanantenana|tsia fanantenana|alahelo|renim-pitondram-pon/i
  ];
  for (const pattern of urgencyPatterns) {
    if (pattern.test(userText)) return true;
  }
  return false;
}

function getUrgencyResponse(platform) {
  const contact = MEMBER_CONTACTS.didier;
  return `Je comprends que c'est important pour toi. 💙\n\nUn membre de notre équipe peut t'aider directement :\n\n👤 ${contact.name} — ${contact.role}\n📱 ${contact.phone}\n\nN'hésite pas à le/la contacter. Tu n'es pas seul(e). 🙏`;
}

// ============================================
// PERSONNALITÉ / SYSTEM PROMPT
// ============================================
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
- Site officiel : https://pcm.ifree.page/
- Si on te pose des questions générales sur PCM, tu peux expliquer ce contexte avec tes propres mots.
- Si l'utilisateur demande le site web ou plus d'informations, donne ce lien : https://pcm.ifree.page/

IDENTITÉ :
- Tu représentes cette association, mais tu parles comme un membre proche de la communauté.
- Si on te demande qui tu es, présente-toi simplement comme l'assistant de "Réseau PCM Ambolokandrina".

LANGUES :
- Tu maîtrises le malagasy, le français et l'anglais.
- Réponds TOUJOURS dans la même langue que celle utilisée par l'utilisateur.
- Si la langue n'est pas claire, réponds en malagasy par défaut.

STYLE :
- Sois chaleureux, proche et naturel.
- Tutoie la personne (ou utilise le registre familier en malagasy : "ianao").
- Utilise des expressions courantes et amicales (ex: "Salama e!", "Miarahaba!", "Tsara be izany!").
- Un emoji de temps en temps est bienvenu.
- Reste concis et utile.
- Si tu ne connais pas une information, dis-le et propose de rediriger vers un responsable.

ACTUALITÉS DE L'ASSOCIATION (à jour au ${new Date().toLocaleDateString('fr-FR')}) :
- Élections du bureau tenues aujourd'hui, résultats votés :
  • Président : Didier
  • Vice-président : Floberto
  • Secrétaires : Nancy et Brunda
  • Trésorerie : Deleo
- Un appel vidéo a eu lieu avec les membres vivant à l'étranger pour discuter de l'opportunité de bourses d'études.
- La journée s'est terminée par un "Fiarahamisakafo" (repas partagé communautaire).

PROPOSITIONS DE THÈME EN FIN DE CONVERSATION :
- Quand la conversation touche à sa fin, propose 2 à 3 thèmes liés aux actualités.
- Adapte à la langue de la conversation.
- Ne propose pas de thèmes à chaque message.`;

// ============================================
// VARIABLES DYNAMIQUES
// ============================================
let DYNAMIQUES_ACTUALITES = '';
let MEMBER_CONTACTS = {
  didier: { name: 'Didier', role: 'Président', phone: '+261 34 00 000 00' },
  floberto: { name: 'Floberto', role: 'Vice-président', phone: '+261 34 00 000 00' },
  nancy: { name: 'Nancy', role: 'Secrétaire', phone: '+261 34 00 000 00' },
  brunda: { name: 'Brunda', role: 'Secrétaire', phone: '+261 34 00 000 00' },
  deleo: { name: 'Deleo', role: 'Trésorier', phone: '+261 34 00 000 00' },
};

// ============================================
// 1. WEBHOOK VERIFICATION
// ============================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook vérifié ✅');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ============================================
// 2. RÉCEPTION DES MESSAGES
// ============================================
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED');
    for (const entry of body.entry) {
      const webhookEvent = entry.messaging[0];
      const senderId = webhookEvent.sender.id;

      if (webhookEvent.message && webhookEvent.message.quick_reply && webhookEvent.message.quick_reply.payload) {
        await handleQuickReply(senderId, webhookEvent.message.quick_reply.payload, 'messenger');
        continue;
      }
      if (webhookEvent.message && webhookEvent.message.text) {
        await handleMessage(senderId, webhookEvent.message.text, 'messenger');
      }
      if (webhookEvent.postback) {
        await handleQuickReply(senderId, webhookEvent.postback.payload, 'messenger');
      }
    }
  } else if (body.object === 'whatsapp_business_account') {
    res.status(200).send('EVENT_RECEIVED');
    for (const entry of body.entry) {
      for (const change of (entry.changes || [])) {
        const messages = change.value?.messages;
        if (messages && messages.length > 0) {
          const message = messages[0];
          const senderId = message.from;
          if (message.type === 'text') {
            await handleMessage(senderId, message.text.body, 'whatsapp');
          } else if (message.type === 'interactive') {
            const payload = message.interactive?.list_reply?.id || message.interactive?.button_reply?.id;
            if (payload) await handleWhatsAppQuickReply(senderId, payload);
          }
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

// ============================================
// RETRY UTILITY
// ============================================
async function axiosWithRetry(fn, retries = 2, delayMs = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      const isRetryable = err.response && (err.response.status === 429 || err.response.status >= 500);
      if (!isRetryable) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
}

// ============================================
// 3. LOGIQUE DU BOT
// ============================================
async function handleMessage(senderId, userText, platform) {
  try {
    const rateLimitKey = `${platform}:${senderId}`;
    if (isRateLimited(rateLimitKey)) {
      const msg = "Ouf, doucement ! 😄 J'ai reçu beaucoup de messages. Réessaie dans quelques secondes.";
      if (platform === 'messenger') await sendMessengerMessage(senderId, msg);
      else await sendWhatsAppMessage(senderId, msg);
      return;
    }

    if (platform === 'messenger') await sendTypingIndicator(senderId, true);

    // --- DÉTECTION D'URGENCE (AVANT TOUT) ---
    if (detectUrgency(userText)) {
      const urgencyMsg = getUrgencyResponse(platform);
      if (platform === 'messenger') {
        await sendTypingIndicator(senderId, false);
        await sendMessengerMessage(senderId, urgencyMsg);
      } else {
        await sendWhatsAppMessage(senderId, urgencyMsg);
      }
      return;
    }

    // --- DOCUMENTS PDF (avant réponses rapides) ---
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
        await sendMessengerDocument(senderId, docUrl);
      } else {
        await sendWhatsAppMessage(senderId, introMsg);
        await sendWhatsAppMessage(senderId, `📥 Télécharge ici :\n${docUrl}`);
      }
      return;
    }

    // --- RÉPONSES RAPIDES (Messenger ET WhatsApp) ---
    const quickResponse = checkQuickResponse(userText);
    if (quickResponse) {
      if (platform === 'messenger') await sendTypingIndicator(senderId, false);
      if (platform === 'messenger') await sendMessengerMessage(senderId, quickResponse);
      else await sendWhatsAppMessage(senderId, quickResponse);
      return;
    }

    // --- CONTACTS MEMBRES ---
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

    // --- HISTORIQUE & PRÉFÉRENCES ---
    const historyKey = `${platform}:${senderId}`;
    if (!conversationHistory[historyKey]) conversationHistory[historyKey] = [];
    conversationHistory[historyKey].push({ role: 'user', content: userText });
    conversationHistory[historyKey].lastActivity = Date.now();

    // Tracker la langue de l'utilisateur
    if (!userPreferences[historyKey]) userPreferences[historyKey] = {};
    userPreferences[historyKey].lastSeen = Date.now();
    if (detectLanguage(userText)) userPreferences[historyKey].language = detectLanguage(userText);

    const userMessageCount = conversationHistory[historyKey].filter(m => m.role === 'user').length;
    const recentHistory = conversationHistory[historyKey].slice(-12);

    // --- CONSTRUCTION DU PROMPT IA ---
    let fullSystemPrompt = SYSTEM_PROMPT;
    if (DYNAMIQUES_ACTUALITES) {
      fullSystemPrompt += `\n\nACTUALITÉS DYNAMIQUES :\n${DYNAMIQUES_ACTUALITES}`;
    }

    // Enrichir si c'est une question PCM
    const isPCM = detectPCMQuestions(userText);
    if (isPCM) {
      fullSystemPrompt += `\n\nNOTE : L'utilisateur pose une question spécifique sur PCM. Réponds de manière détaillée et structurée en te basant sur le contexte ci-dessus.`;
    }

    const sessionLang = userPreferences[historyKey]?.language || 'inconnu';
    const sessionContext = `Plateforme: ${platform}. Langue détectée de l'utilisateur: ${sessionLang}.`;
    const enhancedHistory = [
      { role: 'system', content: sessionContext },
      ...recentHistory
    ];

    // --- APPEL IA ---
    const groqResponse = await axiosWithRetry(() =>
      axios.post(GROQ_URL, {
        model: GROQ_MODEL,
        max_tokens: 600,
        temperature: 0.7,
        messages: [{ role: 'system', content: fullSystemPrompt }, ...enhancedHistory],
      }, {
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      })
    );

    let botReply = groqResponse.data.choices[0].message.content;

    // Lien site tous les 4 messages
    if (userMessageCount % 4 === 0) {
      botReply += `\n\n🌐 Plus d'infos : ${WEBSITE_URL}`;
    }

    conversationHistory[historyKey].push({ role: 'assistant', content: botReply });

    // Photos des membres
    const mentionedPhotos = findMentionedMemberPhotos(userText);

    if (platform === 'messenger') {
      await sendTypingIndicator(senderId, false);
      await sendMessengerMessage(senderId, botReply);
      for (const filename of mentionedPhotos) {
        await sendMessengerImage(senderId, `${BASE_URL}/public/images/${filename}`);
      }
      if (recentHistory.length <= 4) {
        await sendQuickReplies(senderId, "Que veux-tu savoir ?", MAIN_MENU_BUTTONS);
      }
    } else {
      await sendWhatsAppMessage(senderId, botReply);
      for (const filename of mentionedPhotos) {
        await sendWhatsAppImage(senderId, `${BASE_URL}/public/images/${filename}`);
      }
      if (recentHistory.length <= 4) {
        await sendWhatsAppMainMenu(senderId);
      }
    }
  } catch (error) {
    console.error('Erreur handleMessage:', error?.response?.data || error.message);
    const errMsg = "Désolé, une erreur est survenue. Réessaie dans un instant 🙏";
    if (platform === 'messenger') await sendMessengerMessage(senderId, errMsg);
    else await sendWhatsAppMessage(senderId, errMsg);
  }
}

// ============================================
// DÉTECTION DE LANGUE
// ============================================
function detectLanguage(text) {
  const lower = text.toLowerCase();
  if (/\b(manahoana|salama|tsara|veloma|tena|aza|manampy|mbola|akory|izany|faly|tsia|anaova)\b/i.test(lower)) return 'mg';
  if (/\b(the|is|are|how|what|where|when|why|hello|thank|please|join|church|student)\b/i.test(lower)) return 'en';
  if (/[àâéèêëïîôùûüÿç]/i.test(lower)) return 'fr';
  return null;
}

// ============================================
// FONCTIONS DE DÉTECTION
// ============================================

function findRequestedDocument(userText) {
  const n = userText.toLowerCase();
  if (/manuel.*pcm|pcm.*manual|guide.*pcm|pcm.*guide|pcm.*manuel/i.test(n)) return DOCUMENTS.pcm_manual;
  if (/manuel.*adventiste|manuel.*église|church.*manual|adventist.*manual|manuel.*septième|sda.*manuel|manuel.*sda/i.test(n)) return DOCUMENTS.church_manual;
  if (/document|manuel|guide|pdf|documentation|literature/i.test(n)) return 'LIST';
  return null;
}

function findMemberContact(userText) {
  const patterns = [
    { pattern: /didier/i, key: 'didier' },
    { pattern: /floberto/i, key: 'floberto' },
    { pattern: /nancy/i, key: 'nancy' },
    { pattern: /brunda/i, key: 'brunda' },
    { pattern: /deleo/i, key: 'deleo' },
  ];
  const hasContactKeyword = /contact|num|numéro|téléphone|phone|appel|joindre|whatsapp|viber|signal/i.test(userText);
  if (!hasContactKeyword) return null;
  for (const { pattern, key } of patterns) {
    if (pattern.test(userText)) return MEMBER_CONTACTS[key] || null;
  }
  return null;
}

function findMentionedMemberPhotos(userText) {
  const normalized = userText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const matches = [];
  for (const [name, filename] of Object.entries(MEMBER_PHOTOS)) {
    if (normalized.includes(name)) matches.push(filename);
  }
  return matches;
}

function detectPCMQuestions(userText) {
  const n = userText.toLowerCase();
  const patterns = [
    /qu'est-ce que pcm|c'est quoi pcm|pcm.*mission|pcm.*objectif|pcm.*bénéfice|pcm.*avantage|comment.*pcm|pcm.*participer|pcm.*rejoindre|pcm.*leader|pcm.*certification|pcm.*niveau|pcm.*événement|pcm.*weekend|pcm.*world day|pcm.*jour mondial/i,
    /\bacf\b|\basa\b|\bmupa\b|adventist christian fellowship|adventist students association|ministerio.*universitarios/i
  ];
  return patterns.some(p => p.test(n));
}

// ============================================
// RÉPONSES RAPIDES (Messenger + WhatsApp)
// ============================================
const QUICK_RESPONSES = {
  greetings: {
    patterns: [/^(salut|bonjour|bonsoir|hello|hi|hey|salama|manahoana)/i, /^mbola tsara$/i, /^akory$/i],
    responses: {
      fr: "Salut ! 😊 Bienvenue dans l'espace du Réseau PCM Ambolokandrina ! Comment puis-je t'aider aujourd'hui ?",
      mg: "Salama e ! 😊 Tongasoa amin'ny toeram-piraisiana PCM Ambolokandrina ! Ahoana no afaka manampy anao aho androany ?",
      en: "Hi ! 😊 Welcome to the PCM Ambolokandrina network space ! How can I help you today ?"
    }
  },
  goodbye: {
    patterns: [/^(au revoir|bye|goodbye|totampitso|veloma)/i, /^merci.*bye/i, /^tsaotra.*veloma/i],
    responses: {
      fr: "Merci pour ta visite ! N'hésite pas à revenir si tu as d'autres questions. À bientôt ! 👋",
      mg: "Misaotra tsara anao! Aza misalasala miverina raha manana fanontaniana hafa ianao. Veloma ! 👋",
      en: "Thanks for visiting! Don't hesitate to come back. See you soon! 👋"
    }
  },
  participate: {
    patterns: [/comment.*participer|comment.*rejoindre|comment.*adhérer|how.*join|how.*participate|ajoina.*pcm|miara.*mitondra/i],
    responses: {
      fr: "Pour rejoindre le Réseau PCM Ambolokandrina :\n1. Contacter un responsable local (Didier, Floberto, Nancy, Brunda ou Deleo)\n2. Assister à notre prochaine réunion\n3. Nous suivre sur les réseaux sociaux\n\nTu veux qu'on te mette en contact ?",
      mg: "Handray anjara amin'ny RTP PCM Ambolokandrina ianao raha:\n1. Mifandray amin'ny mpitondra toerana\n2. Mankany amin'ny fihaonana mipetraka\n3. Manaraka anay amin'ny sehatra sosika",
      en: "To join the PCM Ambolokandrina Network:\n1. Contact a local leader directly\n2. Attend our next meeting\n3. Follow us on social media"
    }
  },
  events: {
    patterns: [/prochain.*événement|événement.*à venir|prochaine.*réunion|calendar|agenda|fomba.*fihaonana|next.*event/i],
    responses: {
      fr: "Prochains événements :\n📅 Octobre : PCM Weekend\n📅 Fin juin : Jour Mondial du PCM\n\nTu veux en savoir plus ?",
      mg: "Ireto avy ny fihaonana:\n📅 Oktobra : PCM Weekend\n📅 Faran'ny Jona : Andron'ny PCM eran-tany",
      en: "Upcoming events:\n📅 October: PCM Weekend\n📅 Late June: PCM World Day"
    }
  },
  leadership: {
    patterns: [/qui.*dirige|bureau|président|responsable|leader|mpitondra|who.*lead|who.*president/i],
    responses: {
      fr: "Notre bureau élu :\n👤 Président : Didier\n👤 Vice-président : Floberto\n👤 Secrétaires : Nancy et Brunda\n👤 Trésorier : Deleo\n\nTu veux contacter l'un d'entre eux ?",
      mg: "Ireto avy ny biraon'ny mpitondra:\n👤 Loham-panjakana : Didier\n👤 Lohahevitra : Floberto\n👤 Katiprofia : Nancy sy Brunda\n👤 Mpitsabo-sampanaka : Deleo",
      en: "Our elected leadership:\n👤 President: Didier\n👤 VP: Floberto\n👤 Secretaries: Nancy & Brunda\n👤 Treasurer: Deleo"
    }
  },
  scholarships: {
    patterns: [/bourse|scholarship|étude.*étranger|study.*abroad|vadiboly/i],
    responses: {
      fr: "Nous avons discuté des opportunités de bourses à l'étranger lors d'un appel vidéo.\n\nPour les détails, contacte Didier (Président).",
      mg: "Niresaka momba ny vadiboly ivelany isika vao taloha.\n\nHo fanampiana, mifandray amin'ny Président Didier.",
      en: "We discussed scholarship opportunities abroad recently.\n\nFor details, contact Didier (President)."
    }
  },
  site: {
    patterns: [/site|web|site web|page|lien|url|ifree/i],
    responses: {
      fr: "🌐 Voici notre site officiel :\nhttps://pcm.ifree.page/",
      mg: "🌐 Ilay tranonkala ofisialy:\nhttps://pcm.ifree.page/",
      en: "🌐 Our official website:\nhttps://pcm.ifree.page/"
    }
  },
  contacts: {
    patterns: [/liste.*contact|tous.*contact|numéros|téléphone|whatsapp.*bureau|comment.*contacter|membres.*bureau|liste.*membres/i],
    responses: null
  },
  documents: {
    patterns: [/manuel|document|guide|pdf|documentation|literature/i],
    responses: null
  }
};

function checkQuickResponse(userText) {
  const normalized = userText.trim();
  for (const [category, data] of Object.entries(QUICK_RESPONSES)) {
    for (const pattern of data.patterns) {
      if (pattern.test(normalized)) {
        if (category === 'contacts') {
          let list = '📋 Contacts du bureau :\n\n';
          for (const contact of Object.values(MEMBER_CONTACTS)) {
            list += `👤 ${contact.name} — ${contact.role}\n📱 ${contact.phone}\n\n`;
          }
          list += 'Envoie le nom d\'un membre pour son contact !';
          return list;
        }
        if (category === 'documents') {
          let docList = '📄 Documents disponibles :\n\n';
          for (const doc of Object.values(DOCUMENTS)) {
            docList += `• ${doc.title} — ${doc.description}\n`;
          }
          docList += '\nEnvoie le nom du document que tu veux !';
          return docList;
        }
        let lang = 'fr';
        if (/[aàâéèêëïîôùûüÿç]/i.test(normalized) === false && /\b(the|is|are|how|what|where|when|why)\b/i.test(normalized)) lang = 'en';
        else if (/\b(manahoana|salama|tsara|veloma|tena|aza|manampy)\b/i.test(normalized)) lang = 'mg';
        return data.responses[lang] || data.responses.fr;
      }
    }
  }
  return null;
}

// ============================================
// ENVOI MESSAGES
// ============================================
async function sendMessengerMessage(senderId, text) {
  const chunks = text.match(/[\s\S]{1,1900}/g) || [text];
  for (const chunk of chunks) {
    await axiosWithRetry(() => axios.post(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: senderId }, message: { text: chunk } }
    ));
  }
}

async function sendMessengerImage(senderId, imageUrl) {
  await axiosWithRetry(() => axios.post(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    { recipient: { id: senderId }, message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } } }
  ));
}

async function sendMessengerDocument(senderId, docUrl) {
  await axiosWithRetry(() => axios.post(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    { recipient: { id: senderId }, message: { attachment: { type: 'file', payload: { url: docUrl, is_reusable: true } } } }
  ));
}

async function sendWhatsAppMessage(recipientPhone, text) {
  const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
  for (const chunk of chunks) {
    await axiosWithRetry(() => axios.post(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: recipientPhone, type: 'text', text: { body: chunk } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    ));
  }
}

async function sendWhatsAppImage(senderId, imageUrl) {
  await axiosWithRetry(() => axios.post(
    `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: senderId,
      type: 'image',
      image: { link: imageUrl }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  ));
}

async function sendTypingIndicator(senderId, isTyping) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: senderId }, sender_action: isTyping ? 'typing_on' : 'typing_off' }
    );
  } catch (e) { /* non bloquant */ }
}

async function sendQuickReplies(senderId, text, quickReplies) {
  await axiosWithRetry(() => axios.post(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      recipient: { id: senderId },
      messaging_type: 'RESPONSE',
      message: { text, quick_replies: quickReplies.map(r => ({ content_type: 'text', title: r.title, payload: r.payload })) }
    }
  ));
}

async function sendWhatsAppListMessage(recipientPhone, bodyText, buttonText, sections) {
  await axiosWithRetry(() => axios.post(
    `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to: recipientPhone, type: 'interactive', interactive: { type: 'list', body: { text: bodyText }, action: { button: buttonText, sections } } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  ));
}

async function sendWhatsAppButtonsMessage(recipientPhone, bodyText, buttons) {
  await axiosWithRetry(() => axios.post(
    `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to: recipientPhone, type: 'interactive', interactive: { type: 'button', body: { text: bodyText }, action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) } } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  ));
}

// ============================================
// MENUS & QUICK REPLIES
// ============================================
const MAIN_MENU_BUTTONS = [
  { title: "📋 PCM Expliqué", payload: "QUICK_PCM_INFO" },
  { title: "👥 Bureau élu", payload: "QUICK_LEADERSHIP" },
  { title: "📅 Événements", payload: "QUICK_EVENTS" },
  { title: "📄 Documents", payload: "QUICK_DOCUMENTS" },
  { title: "🤝 Participer", payload: "QUICK_PARTICIPATE" }
];

async function handleQuickReply(senderId, payload, platform) {
  if (platform !== 'messenger') return false;

  if (payload === 'GET_STARTED') {
    await sendMessengerMessage(senderId, "Salama e ! 😊\n\nBienvenue au Réseau PCM Ambolokandrina !\n\nJe suis là pour t'aider à en savoir plus sur PCM, nos activités, notre bureau et bien d'autres choses.\n\nN'hésite pas à me poser des questions !");
    await sendQuickReplies(senderId, "Que veux-tu savoir ?", MAIN_MENU_BUTTONS);
    return true;
  }

  const quickResponses = {
    QUICK_PCM_INFO: "PCM (Public Campus Ministry) est un ministère mondial de l'Église Adventiste qui soutient les étudiants adventistes sur les campus universitaires non-adventistes.\n\n🎯 Mission : Aider les jeunes à s'enraciner dans leur foi et à partager l'évangile.\n\nTu veux en savoir plus ?",
    QUICK_LEADERSHIP: "Notre bureau élu :\n👤 Président : Didier\n👤 Vice-président : Floberto\n👤 Secrétaires : Nancy et Brunda\n👤 Trésorier : Deleo\n\nTu veux contacter l'un d'entre eux ?",
    QUICK_EVENTS: "Prochains événements :\n📅 Octobre : PCM Weekend\n📅 Fin juin : Jour Mondial du PCM\n\nTu veux participer ?",
    QUICK_SCHOLARSHIPS: "Bourses d'études à l'étranger.\n\nContacte le bureau pour les détails.",
    QUICK_PARTICIPATE: "Pour rejoindre le PCM :\n1. Contacte un responsable local\n2. Assiste à nos réunions\n3. Suis-nous sur les réseaux sociaux",
    QUICK_DOCUMENTS: null,
  };

  if (payload === 'QUICK_DOCUMENTS') {
    let docList = '📄 Documents disponibles :\n\n';
    for (const doc of Object.values(DOCUMENTS)) docList += `• ${doc.title} — ${doc.description}\n`;
    docList += '\nEnvoie le nom du document !';
    await sendMessengerMessage(senderId, docList);
    return true;
  }

  if (quickResponses[payload]) {
    await sendMessengerMessage(senderId, quickResponses[payload]);
    return true;
  }
  return false;
}

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
  await sendWhatsAppListMessage(recipientPhone, 'Que veux-tu savoir sur le Réseau PCM Ambolokandrina ?', '📋 Menu', sections);
}

async function handleWhatsAppQuickReply(senderId, payload) {
  const responses = {
    WA_PCM_INFO: "PCM (Public Campus Ministry) est un ministère mondial de l'Église Adventiste.\n\n🎯 Mission : Aider les jeunes à s'enraciner dans leur foi.\n\nTu veux en savoir plus ?",
    WA_LEADERSHIP: "Notre bureau élu :\n👤 Président : Didier\n👤 Vice-président : Floberto\n👤 Secrétaires : Nancy et Brunda\n👤 Trésorier : Deleo",
    WA_EVENTS: "Prochains événements :\n📅 Octobre : PCM Weekend\n📅 Fin juin : Jour Mondial du PCM",
    WA_SCHOLARSHIPS: "Bourses d'études à l'étranger.\nContacte Didier (Président) pour les détails.",
    WA_PARTICIPATE: "Pour rejoindre le PCM :\n1. Contacte un responsable local\n2. Assiste à nos réunions\n3. Suis-nous sur les réseaux sociaux",
    WA_DOCUMENTS: null,
    WA_MENU: null,
  };

  if (payload === 'WA_DOCUMENTS') {
    await sendWhatsAppMessage(senderId, `📄 Documents disponibles :\n\n1. ${DOCUMENTS.pcm_manual.title}\n2. ${DOCUMENTS.church_manual.title}\n\nEnvoie le nom du document !`);
    return;
  }

  if (payload === 'WA_MENU') {
    await sendWhatsAppMainMenu(senderId);
    return;
  }

  if (responses[payload]) {
    await sendWhatsAppMessage(senderId, responses[payload]);
    await sendWhatsAppButtonsMessage(senderId, 'Autre chose ?', [
      { id: 'WA_MENU', title: '📋 Menu' },
      { id: 'WA_PCM_INFO', title: '📋 PCM' },
      { id: 'WA_PARTICIPATE', title: '🤝 Participer' }
    ]);
  }
}

// ============================================
// ROUTES SÉCURISÉES (admin)
// ============================================
app.get('/setup-messenger', adminAuth, async (req, res) => {
  const results = {};
  try {
    await axios.post(`https://graph.facebook.com/v21.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`, { get_started: { payload: 'GET_STARTED' } });
    results.get_started = 'OK';
  } catch (err) { results.get_started = err?.response?.data?.error?.message || err.message; }
  results.greeting = 'Configurer manuellement dans Facebook Page Settings > Messaging > Greeting Text';
  try {
    await axios.post(`https://graph.facebook.com/v21.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`, {
      persistent_menu: [{ locale: 'default', composer_input_disabled: false, call_to_actions: [
        { type: 'postback', title: 'PCM Explique', payload: 'QUICK_PCM_INFO' },
        { type: 'postback', title: 'Notre bureau', payload: 'QUICK_LEADERSHIP' },
        { type: 'postback', title: 'Evenements', payload: 'QUICK_EVENTS' },
        { type: 'postback', title: 'Documents', payload: 'QUICK_DOCUMENTS' },
        { type: 'postback', title: 'Participer', payload: 'QUICK_PARTICIPATE' }
      ] }]
    });
    results.persistent_menu = 'OK';
  } catch (err) { results.persistent_menu = err?.response?.data?.error?.message || err.message; }
  try {
    await axios.post(`https://graph.facebook.com/v21.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`, {
      whitelisted_domains: [BASE_URL, 'https://bot-messenger-reseaupcm-1.onrender.com']
    });
    results.whitelisted_domains = 'OK';
  } catch (err) { results.whitelisted_domains = err?.response?.data?.error?.message || err.message; }
  res.json({ success: true, results });
});

app.get('/stats', (req, res) => {
  const totalConversations = Object.keys(conversationHistory).length;
  const now = Date.now();
  let activeLast5min = 0, activeLast1h = 0;
  for (const key in conversationHistory) {
    const la = conversationHistory[key].lastActivity;
    if (la) {
      if (now - la < 5 * 60 * 1000) activeLast5min++;
      if (now - la < 60 * 60 * 1000) activeLast1h++;
    }
  }
  res.json({ totalConversations, activeLast5min, activeLast1h, uptime: process.uptime(), memoryUsage: process.memoryUsage() });
});

app.get('/actualites', (req, res) => {
  res.json({ actualites: DYNAMIQUES_ACTUALITES || 'Aucune actualité dynamique.' });
});

app.post('/update-actualites', adminAuth, (req, res) => {
  const { actualites } = req.body;
  if (!actualites || typeof actualites !== 'string') return res.status(400).json({ success: false, error: 'Champ "actualites" requis.' });
  DYNAMIQUES_ACTUALITES = actualites;
  console.log('Actualités mises à jour');
  res.json({ success: true });
});

app.get('/contacts', adminAuth, (req, res) => {
  res.json({ contacts: MEMBER_CONTACTS });
});

app.post('/update-contacts', adminAuth, (req, res) => {
  const { contacts, member, phone, name, role } = req.body;
  if (contacts && typeof contacts === 'object') {
    MEMBER_CONTACTS = { ...MEMBER_CONTACTS, ...contacts };
    return res.json({ success: true, contacts: MEMBER_CONTACTS });
  }
  if (member && phone) {
    const key = member.toLowerCase();
    if (!MEMBER_CONTACTS[key]) MEMBER_CONTACTS[key] = { name: name || member, role: role || 'Membre', phone };
    else { if (phone) MEMBER_CONTACTS[key].phone = phone; if (name) MEMBER_CONTACTS[key].name = name; if (role) MEMBER_CONTACTS[key].role = role; }
    return res.json({ success: true, contact: MEMBER_CONTACTS[key] });
  }
  res.status(400).json({ success: false, error: 'Fournis "contacts" ou "member" + "phone".' });
});

// ============================================
// ANNONCE PROGRAMMÉE — envoyer un message à tous les utilisateurs actifs
// POST /broadcast { "message": "Texte de l'annonce" }
// ============================================
app.post('/broadcast', adminAuth, async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ success: false, error: 'Champ "message" requis.' });

  const now = Date.now();
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const activeUsers = [];

  for (const key in conversationHistory) {
    if (conversationHistory[key].lastActivity && conversationHistory[key].lastActivity > oneWeekAgo) {
      const [platform, senderId] = key.split(':');
      activeUsers.push({ platform, senderId });
    }
  }

  let sent = 0, failed = 0;
  for (const user of activeUsers) {
    try {
      if (user.platform === 'messenger') await sendMessengerMessage(user.senderId, `📢 Annonce :\n\n${message}`);
      else await sendWhatsAppMessage(user.senderId, `📢 Annonce :\n\n${message}`);
      sent++;
    } catch (e) { failed++; }
  }

  database.broadcastHistory.push({ date: new Date().toISOString(), message, sent, failed, total: activeUsers.length });
  saveDB();

  res.json({ success: true, sent, failed, total: activeUsers.length });
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
  const checks = { server: 'OK', groq: 'unknown', facebook: 'unknown' };

  try {
    await axios.get('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, timeout: 5000 });
    checks.groq = 'OK';
  } catch (e) { checks.groq = `ERROR: ${e.response?.status || e.message}`; }

  try {
    await axios.get(`https://graph.facebook.com/v21.0/me?access_token=${PAGE_ACCESS_TOKEN}`, { timeout: 5000 });
    checks.facebook = 'OK';
  } catch (e) { checks.facebook = `ERROR: ${e.response?.status || e.message}`; }

  const allOk = Object.values(checks).every(v => v === 'OK');
  res.status(allOk ? 200 : 503).json(checks);
});

// ============================================
// ROUTE RACINE
// ============================================
app.get('/', (req, res) => {
  res.send('Le bot est en ligne ✅');
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
