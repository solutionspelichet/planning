# Planning Effectifs — backend VPS (Node.js)

Backend Node.js/Express + SQLite (via `better-sqlite3`) avec mises à jour en
temps réel via Server-Sent Events (SSE). Remplace l'ancienne version Google
Apps Script.

Aucun mot de passe n'est jamais stocké en clair : hash salé par utilisateur
via `scrypt` (volontairement lent, résiste au brute-force si la base fuit).
Les comptes créés avant ce changement avaient un hash SHA-256 — toujours
reconnu à la connexion, et migré vers `scrypt` automatiquement dès la
prochaine connexion réussie de ce compte (pas de réinitialisation forcée).
Les tentatives de connexion sont aussi limitées (5 échecs sur un compte, ou
20 échecs depuis une même IP, bloquent 5-10 min). **Les identifiants
d'infrastructure (VPS, NPM, Drive, admin app) sont dans `SECRETS.md`,
volontairement exclu de git — voir ce fichier.**

## Infrastructure actuelle (résumé)

Ce projet tourne sur un **VPS Ionos partagé** qui héberge aussi d'autres
sites (n8n, avatar.guedou.ch, goudai-chat, trading-copilot, waha...). Le VPS
n'est PAS dédié à ce projet — toute action dessus (redémarrage, pare-feu,
etc.) peut affecter ces autres services.

```
Internet → DNS (Ionos, zone guedou.ch)
             planning.pelichet.guedou.ch → 87.106.213.25
         → Nginx Proxy Manager (Docker, port 80/443, gère TOUS les sites du VPS)
             panel d'admin NPM : http://87.106.213.25:81
         → proxy_pass vers 172.19.0.1:3003 (passerelle Docker → hôte)
         → planning-app.service (systemd, Node.js, port 3003, user www-data)
             /opt/planning-app/server.js
             /opt/planning-app/public/index.html
             /opt/planning-app/data/planning.db (SQLite, mode WAL)
```

**Pourquoi `172.19.0.1` et pas `127.0.0.1` ou `localhost` ?** NPM tourne
dans un conteneur Docker sur le réseau `n8n-docker_default` ; depuis
l'intérieur d'un conteneur, `127.0.0.1` désigne le conteneur lui-même, pas
l'hôte. `172.19.0.1` est la passerelle de ce réseau Docker — c'est comment
NPM atteint le port 3003 qui écoute sur l'hôte. Pour retrouver cette IP si
le réseau est recréé un jour :
```bash
docker network inspect n8n-docker_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

## Accès SSH

```bash
ssh -p 22022 root@87.106.213.25
```
Port **22022**, pas 22 (le pare-feu Ionos bloque 22). Authentification par
clé (`~/.ssh/id_ed25519`). Mot de passe de secours dans `SECRETS.md`.

## Déployer une mise à jour

**Automatique** : tout push sur la branche `main-63nl54` du repo GitHub
(`solutionspelichet/planning`) déclenche `.github/workflows/deploy.yml` :

1. **`test`** — installe les dépendances, lance la suite Playwright complète
   (`npm run test:e2e`, voir plus bas). Le déploiement ne se lance pas si un
   test échoue.
2. **`deploy`** (seulement si `test` est vert) :
   - Sauvegarde la base courante sur le VPS (`VACUUM INTO
     avant-deploiement-*.db`) avant de toucher quoi que ce soit — visible et
     téléchargeable depuis l'onglet Admin comme les autres sauvegardes.
   - Copie `server.js` et `public/index.html` sur le VPS via SSH (secrets
     `VPS_HOST`/`VPS_PORT`/`VPS_USER`/`VPS_SSH_KEY` du repo GitHub).
   - `systemctl restart planning-app`.

Pas de déploiement manuel à faire depuis un poste local. Pour contourner
le pipeline en urgence (déconseillé — plus de garde-fou), la méthode manuelle
reste :
```bash
scp -P 22022 server.js root@87.106.213.25:/opt/planning-app/server.js
scp -P 22022 public/index.html root@87.106.213.25:/opt/planning-app/public/index.html
ssh -p 22022 root@87.106.213.25 "systemctl restart planning-app"
```

**Important** : redémarrer le service coupe toutes les sessions actives
(stockées en mémoire, pas en base) — tout le monde devra se reconnecter.
Le service a `Restart=always` dans systemd, donc il revient automatiquement
après un arrêt (vérifié : `systemctl show planning-app -p Restart`).

Si vous modifiez le schéma SQLite dans `server.js`, ajoutez une migration
idempotente (voir les fonctions `migrateVehicleType` /
`migrateDossierDisplayOrder` dans le fichier) — ne modifiez jamais une
colonne existante directement, la base de prod contient déjà des données.

## Suite de tests (Playwright)

```bash
npm run test:e2e
```

Lance le vrai `server.js` sur une base SQLite jetable (jamais `data/`) et
pilote un vrai navigateur (Chromium) dessus — voir `playwright.config.js`
et `tests/global-setup.js`. Les fichiers de `tests/e2e/` couvrent : auth +
limitation de tentatives, CRUD dossiers, conflits de double-réservation et
d'absence/immobilisation, exports CSV/PDF (jour, semaine, mois), le tableau
Vacances & Garage, le statut de synchro Drive, l'affichage mobile (pas de
débordement horizontal à 390px) et l'archivage des vieux dossiers.

C'est cette même suite qui gate le déploiement automatique (ci-dessus) —
un changement qui casse un de ces comportements ne part pas en prod.

## Reverse proxy (Nginx Proxy Manager)

Ce VPS n'utilise **pas** nginx+certbot classique malgré ce que `deploy.sh`
installe (script conservé pour référence mais plus utilisé en pratique) —
tout passe par **Nginx Proxy Manager**, déjà en place pour les autres sites.

Panel : http://87.106.213.25:81 (identifiants dans `SECRETS.md`).

La configuration du proxy host "planning.pelichet.guedou.ch" :
- Forward vers `172.19.0.1:3003` (http)
- Certificat Let's Encrypt géré par NPM
- `allow_websocket_upgrade` activé
- Config avancée (obligatoire pour le temps réel SSE, sinon le flux se
  bloque après un délai) :
  ```nginx
  location /api/events {
    proxy_pass http://172.19.0.1:3003;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_cache off;
    chunked_transfer_encoding off;
    proxy_read_timeout 24h;
  }
  ```

Si vous devez refaire ce proxy host depuis zéro, utilisez l'API NPM
(`POST /api/nginx/proxy-hosts` après `POST /api/tokens`) plutôt que l'UI —
voir l'historique de ce projet pour des exemples de payloads qui ont marché
(le format `meta` attendu par `POST /api/nginx/certificates` est strict :
seulement `{dns_challenge: false}`, pas de `letsencrypt_email` ni
`letsencrypt_agree` malgré ce que suggère la doc).

## Sauvegardes automatiques

Entièrement gérées par `server.js`, pas de cron système :

- **Planning** : tous les jours à 10h, 14h, 16h, 20h, 22h (heure serveur)
- **Méthode** : `VACUUM INTO` (snapshot SQLite cohérent, safe même pendant
  une écriture concurrente)
- **Rétention locale** : 7 jours (`/opt/planning-app/data/backups/`), purge
  automatique au-delà
- **Google Drive** : chaque sauvegarde est aussi copiée via `rclone` vers
  `solutions.pelichet@gmail.com` → dossier "Planning-Backups" (jamais
  purgée automatiquement côté Drive — c'est la sauvegarde de dernier
  recours)

Config rclone : `/etc/rclone/rclone.conf` (lisible par `www-data`, PAS
`/root/.config/rclone/rclone.conf` qui est utilisé quand on lance `rclone`
en tant que root manuellement — les deux fichiers existent, gardez-les
synchronisés si vous retouchez l'auth Drive).

Dans l'app, onglet **Admin** :
- Liste des sauvegardes VPS avec téléchargement (y compris les snapshots
  `avant-deploiement-*` et `avant-restauration-*` pris automatiquement)
- Bouton "Sauvegarder maintenant"
- **Statut de synchro Drive** : vert si la dernière copie vers Drive a
  réussi récemment, rouge avec le message d'erreur sinon, avertissement si
  aucune synchro réussie depuis plus de 15h (silence qui, avant, ne
  remontait que dans les logs serveur)
- **Restauration** : uploader un fichier `.db` (téléchargé depuis Drive ou
  local) → le serveur le valide, sauvegarde l'état courant par sécurité
  (`avant-restauration-*.db`), puis redémarre pour appliquer le changement
- **Archives** : les dossiers terminés depuis plus de 18 mois ne sont plus
  envoyés avec le planning courant (`/api/all`) pour garder ça léger — ils
  restent cherchables par client/n°/adresse via la carte "Archives"

## En cas de souci

```bash
sudo systemctl status planning-app       # le service tourne-t-il ?
sudo journalctl -u planning-app -f       # logs en direct
sudo journalctl -u planning-app -n 50    # dernières lignes
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3003/   # l'app répond en interne ?
```

Si l'app répond en interne (port 3003) mais pas via le nom de domaine, le
problème vient du proxy NPM, pas de l'app — vérifier le panel NPM
(`http://87.106.213.25:81`) et son conteneur :
```bash
docker ps | grep nginx-proxy-manager
docker logs n8n-docker-nginx-proxy-manager-1 --tail 50
```

## Base de données

Fichier unique SQLite : `/opt/planning-app/data/planning.db` (+ `.db-wal` /
`.db-shm` en mode WAL — ne jamais copier le `.db` seul sans ces fichiers
pour une sauvegarde manuelle, utiliser `VACUUM INTO` à la place) :

```bash
sudo sqlite3 /opt/planning-app/data/planning.db "VACUUM INTO '/root/backup-manuel.db'"
```

(c'est exactement ce que fait le bouton "Sauvegarder maintenant" de l'app).

## Git / GitHub

Repo : [`solutionspelichet/planning`](https://github.com/solutionspelichet/planning),
branche de développement/déploiement : `main-63nl54` (tout push dessus
déclenche le pipeline décrit plus haut). `main` sert de branche stable —
`main-63nl54` y est fusionnée périodiquement via Pull Request.

`SECRETS.md` reste gitignored (jamais poussé) ; les secrets du pipeline
(`VPS_HOST`, `VPS_PORT`, `VPS_USER`, `VPS_SSH_KEY`) sont dans les repo
secrets GitHub (Settings → Secrets and variables → Actions), pas dans ce
fichier.
