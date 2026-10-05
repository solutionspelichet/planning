# Plan de développement — Planning Pelichet

Dernière mise à jour : voir l'historique git de ce fichier.

## Où on en est

L'app couvre : planification (jour/semaine/mois) avec filtres et export
CSV/PDF/impression, effectifs/véhicules, absences & immobilisations avec
détection de conflits et tableau Gantt, dashboard qui suit le mode
Jour/Semaine/Mois (mobilisation, répartition par type et 4 graphiques
annuels, tous avec un comparatif à l'année précédente), historique + undo,
PWA avec notifications, sauvegardes automatiques (vérifiées de bout en
bout, purgées après 7 jours) + copie Google Drive (surveillée), alertes
Telegram (app injoignable, disque faible, échec de synchro), auth
sécurisée (scrypt + limitation de tentatives par compte et par IP),
déploiement auto-testé (suite Playwright complète avant chaque mise en
prod, déploiements sérialisés), archivage des vieux dossiers, colonnes de
tableau réglables, couleurs personnalisables (types, créneaux, motifs,
adresses GM/transit dépôt) dans Settings, et deux jeux dans l'onglet
Détente (casse-briques à 200 niveaux, Tetris).

## Fait

- [x] Sauvegarde automatique de la base avant chaque déploiement, purge
      après 7 jours, copie Google Drive surveillée (Admin)
- [x] Auth : scrypt + migration automatique des anciens hash SHA-256,
      limitation des tentatives par compte ET par IP
- [x] Point de santé public `/api/health` + alertes Telegram (app
      injoignable, disque faible, échec de synchro Drive)
- [x] Pipeline CI/CD : suite Playwright complète avant chaque déploiement,
      déploiements sérialisés (plus de collision entre deux pushes rapprochés)
- [x] Archivage des vieux dossiers (>18 mois) hors du chargement courant,
      recherche à la demande dans l'onglet Admin
- [x] Avertissement sur les numéros de dossier en double
- [x] Export PDF jour + semaine, export CSV mois, impression avec le même
      numéro d'ordre que dans la vue Jour
- [x] Raccourci clavier Ctrl/Cmd+K pour la recherche globale
- [x] Dashboard : les 4 chiffres clés, le tableau de mobilisation et la
      répartition par type suivent le mode Jour/Semaine/Mois, avec un
      comparatif à la même période l'an dernier ; graphique de suivi du
      volume transporté par mois ajouté aux 3 graphiques annuels existants
- [x] Tableaux de disponibilité (Effectifs/Véhicules, Vacances & Garage) :
      colonne nom réglable par glisser-déposer
- [x] Vue Semaine : badges effectif/véhicules "assigné/prévu"
- [x] Correction : un chantier chevauchant un week-end sans "travail le
      week-end" coché n'apparaît plus actif sur les samedis/dimanches
- [x] Settings : couleurs personnalisables pour le texte "GM" et "transit
      depot" saisi dans les champs adresse de départ/arrivée
- [x] Détente : menu de sélection, casse-briques à 200 niveaux générés par
      formule (8 formes, briques résistantes dès le niveau 60), Tetris
      complet (7-bag, pièce suivante, aperçu fantôme, boutons tactiles)
- [x] Durcissement backend : `NODE_ENV=production` par défaut (évite de
      fuiter des stack traces), en-têtes de sécurité de base
      (X-Content-Type-Options, X-Frame-Options, Referrer-Policy), filet de
      récupération sur crash process (log + sortie propre pour que
      systemd redémarre), middleware d'erreur Express global, purge de
      l'historique par dossier au-delà de 200 entrées

## Volontairement pas fait (à confirmer avant de s'y lancer)

- **Rôles plus fins** (au-delà d'admin/planning/user) — seulement si le
  besoin se confirme avec la croissance de l'équipe.
- **Environnement de staging** avant prod — la suite de tests automatisés
  est déjà le principal filet de sécurité ; un vrai staging serait plus
  lourd à maintenir qu'utile tant qu'une seule personne développe dessus.
- **Content-Security-Policy** — l'app charge Google Fonts + un script
  vendored à côté de son propre `<script>`/`<style>` inline ; une CSP mal
  réglée casserait le rendu silencieusement plutôt que de prévenir
  bruyamment, donc pas retenu sans pouvoir tester visuellement chaque onglet.

## Recommandation process (pas du code)

Le plus utile maintenant n'est peut-être pas une nouvelle fonctionnalité
technique : **demander aux gens qui utilisent vraiment l'app au quotidien**
ce qui les frustre ou leur manque, plutôt que de continuer à deviner après
une quarantaine de fonctionnalités ajoutées par itération.
