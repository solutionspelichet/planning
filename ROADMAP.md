# Plan de développement — Planning Pelichet

Dernière mise à jour : voir l'historique git de ce fichier.

## Où on en est

L'app couvre : planification (jour/semaine/mois), effectifs/véhicules,
absences & immobilisations avec détection de conflits, exports CSV/PDF
(jour/semaine/mois), dashboard avec stats, historique + undo, PWA avec
notifications, sauvegardes automatiques (vérifiées de bout en bout) + copie
Google Drive (surveillée), auth sécurisée (scrypt + limitation de
tentatives par compte et par IP), déploiement auto-testé (suite Playwright
complète avant chaque mise en prod, + sauvegarde automatique avant chaque
déploiement), audit mobile fait, archivage des vieux dossiers, et quelques
raccourcis clavier.

## Fait

- [x] Sauvegarde automatique de la base avant chaque déploiement
- [x] README à jour (pipeline CI, fonctionnalités récentes)
- [x] Réinitialisation de mot de passe par un admin lève le blocage de
      tentatives (bug trouvé et corrigé)
- [x] Avertissement sur les numéros de dossier en double (pas
      d'auto-incrémentation — convention de numérotation réelle inconnue,
      deviner aurait été plus risqué que le problème à résoudre)
- [x] Export PDF consolidé de la semaine (en plus du jour déjà existant)
- [x] Archivage des vieux dossiers (>18 mois) hors du chargement courant,
      avec recherche à la demande dans l'onglet Admin
- [x] Limitation des tentatives de connexion aussi par IP (en plus du
      par-compte déjà en place)
- [x] Raccourci clavier Ctrl/Cmd+K pour la recherche globale (les
      raccourcis flèches/N existaient déjà pour la vue Planning jour)
- [x] Point de santé public `/api/health` + surveillance externe (toutes
      les ~10 min) avec alertes Telegram sur changement d'état : app
      injoignable, espace disque faible, échec de synchro Drive (voir
      section "Alertes Telegram" du README pour la mise en place)
- [x] Correction d'une collision de déploiements concurrents (deux pushes
      rapprochés faisaient échouer la sauvegarde pré-déploiement) —
      déploiements désormais sérialisés

## Volontairement pas fait (à confirmer avant de s'y lancer)

- **Rôles plus fins** (au-delà d'admin/planning/user) — seulement si le
  besoin se confirme avec la croissance de l'équipe.
- **Environnement de staging** avant prod — la suite de tests automatisés
  est déjà le principal filet de sécurité ; un vrai staging serait plus
  lourd à maintenir qu'utile tant qu'une seule personne développe dessus.

## Recommandation process (pas du code)

Le plus utile maintenant n'est peut-être pas une nouvelle fonctionnalité
technique : **demander aux gens qui utilisent vraiment l'app au quotidien**
ce qui les frustre ou leur manque, plutôt que de continuer à deviner après
une trentaine de fonctionnalités ajoutées par itération.
