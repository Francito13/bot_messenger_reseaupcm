# Chatbot Facebook Messenger avec IA — Version 100% GRATUITE

Ce projet utilise uniquement des services gratuits :
- **Groq** pour l'IA (modèle Llama 3.3 70B) — gratuit, sans carte bancaire
- **Render** pour l'hébergement — gratuit, sans carte bancaire

## 1. Installation locale

```bash
npm install
cp .env.example .env
```

Remplis le fichier `.env` :
- `VERIFY_TOKEN` : invente une phrase secrète (ex: `abc123secret`)
- `PAGE_ACCESS_TOKEN` : récupéré dans Meta Developer Console (voir ci-dessous)
- `GROQ_API_KEY` : gratuit sur https://console.groq.com/keys (inscription par email, aucune carte requise)

## 2. Configuration Facebook / Meta

### a. Créer la Page Facebook
https://facebook.com/pages/create

### b. Créer l'app développeur
1. https://developers.facebook.com → **Mes apps** → **Créer une app** → type **Entreprise**
2. Dans le tableau de bord de l'app, ajoute le produit **Messenger**

### c. Générer le Page Access Token
**Messenger** → **Paramètres** → **Génération de token** → sélectionne ta Page → copie le token dans `.env`

### d. Configurer le Webhook (à faire après le déploiement, étape 3)
Dans **Messenger** → **Paramètres** → **Webhooks** :
- **URL de rappel** : `https://TON-APP.onrender.com/webhook`
- **Token de vérification** : la même valeur que `VERIFY_TOKEN` dans `.env`
- Coche l'abonnement à l'événement `messages`

## 3. Déploiement gratuit sur Render

1. Crée un compte sur https://render.com (gratuit, pas de carte bancaire nécessaire)
2. Pousse ce dossier sur un dépôt GitHub
3. Sur Render : **New** → **Web Service** → connecte ton dépôt GitHub
4. Configure :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Plan** : Free
5. Dans **Environment**, ajoute tes 3 variables : `VERIFY_TOKEN`, `PAGE_ACCESS_TOKEN`, `GROQ_API_KEY`
6. Déploie → tu obtiens une URL du type `https://ton-bot.onrender.com`
7. Utilise `https://ton-bot.onrender.com/webhook` comme URL de webhook sur Meta (étape 2d)

⚠️ **À savoir sur le plan gratuit Render** : le service se met en veille après 15 minutes
sans trafic. Le premier message envoyé après une pause peut mettre 30 à 60 secondes
à recevoir une réponse (le temps que le serveur se réveille), les suivants sont instantanés.
Pour un usage perso / petite page, c'est largement acceptable.

## 4. Personnaliser le bot
Modifie la variable `SYSTEM_PROMPT` dans `server.js` pour changer la personnalité,
le ton, ou donner des informations spécifiques à ton entreprise/produit au bot.

## 5. Limites du plan gratuit Groq
- 30 requêtes par minute, 14 400 requêtes par jour — largement suffisant pour un bot perso
- Si tu dépasses (peu probable), les messages échouent temporairement ; ça se réinitialise
  automatiquement chaque minute/jour

## 6. Tester
Une fois le webhook validé par Meta, va sur ta Page Facebook → envoie-toi un message
depuis un compte perso (ou demande à un ami) → le bot doit répondre automatiquement.

Note : tant que l'app est en mode "Développement", seuls les rôles admin/testeurs
de l'app peuvent discuter avec le bot. Pour la rendre publique, il faut soumettre
l'app à la revue Meta (App Review) pour la permission `pages_messaging` — cette
étape reste gratuite, elle demande juste un peu de paperasse (vidéo de démo, description).
