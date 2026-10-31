# Historique des versions

## 0.0.2

Première version de MIPS Runner pour VS Code sur ordinateur. Le fichier VSIX joint peut être installé depuis la vue Extensions, via « … » puis « Installer à partir d’un VSIX ».

**User facing changes**

- Assemblez et exécutez un fichier MIPS sans installer MARS ni Java. Lancez le programme, avancez instruction par instruction et retrouvez la prochaine instruction dans l’éditeur.
- Visualisez les registres, les segments data et stack, les adresses et les valeurs modifiées. Suivez une adresse depuis un registre ou le pointeur de pile `$sp`.
- Profitez de la coloration syntaxique, des infobulles sur les instructions courantes et de la validation pendant la saisie.
- À l’ouverture d’un fichier MIPS, choisissez de proposer son chargement, de le charger automatiquement ou de conserver un fonctionnement manuel. La proposition est activée par défaut.
- Utilisez les points d’arrêt dans la liste des instructions assemblées et préparez l’entrée standard avant l’exécution.

**Technical details**

- Première version distribuée : extension VS Code 1.85 ou ultérieur sur ordinateur, avec le moteur SPIM WebAssembly inclus. La version web de VS Code n’est pas encore prise en charge.
- Le validateur signale généralement la première erreur de syntaxe ; il ne détecte pas tous les problèmes d’exécution ni les étiquettes non définies. Les points d’arrêt ne sont pas encore synchronisés avec ceux de VS Code et l’entrée standard n’est pas interactive.
- La vue de la pile est limitée par le moteur et affiche un avertissement lorsque la pile dépasse la zone disponible. Les accès aux fichiers du programme utilisent un système de fichiers virtuel distinct du projet VS Code.
- Les notices des composants tiers sont incluses. La licence propre de MIPS Runner et les notices des composants additionnels de la chaîne Emscripten restent à définir ou vérifier avant toute réutilisation ou redistribution ultérieure.
