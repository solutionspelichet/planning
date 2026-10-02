# Suite de tests end-to-end

Tests Playwright qui font tourner le vrai `server.js` (pas de mock) contre une
base SQLite jetable, pour détecter les régressions sur les fonctionnalités du
Planning (filtres, historique, annulation, exports, PWA, Zen Attitude,
Détente…).

## Lancer les tests

```bash
npm install
npx playwright install chromium   # une seule fois, si Chromium n'est pas déjà installé
npm run test:e2e
```

Chaque run utilise son propre dossier `tests/.tmp-data/` (jamais le `data/`
réel) et repart d'une base propre à chaque lancement — sans danger pour les
données de dev ou de prod.
