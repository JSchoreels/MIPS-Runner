# MIPS Runner

Extension VS Code pour exécuter et inspecter du code assembleur MIPS avec le moteur SPIM de JsSpim, inclus au format WebAssembly. Aucune installation de MARS ou de Java n'est nécessaire.

## Installation

Dans VS Code sur ordinateur, ouvrir la vue **Extensions**, rechercher **MIPS Runner** par **Jisko** et sélectionner **Install**.

Pour installer une version téléchargée depuis GitHub :

1. Télécharger le fichier `.vsix` de la version souhaitée depuis les [releases GitHub](https://github.com/JSchoreels/MIPS-Runner/releases).
2. Dans VS Code sur ordinateur, ouvrir la vue **Extensions**, puis le menu **…** et sélectionner **Install from VSIX…**.
3. Choisir le fichier téléchargé et recharger VS Code si nécessaire.
4. Ouvrir un fichier MIPS et accepter la proposition de chargement, ou lancer **MIPS Runner: Load Active File** depuis la palette de commandes.

Si une version de développement `local.mips-runner` est déjà installée, la désinstaller avant d'installer `Jisko.mips-runner` pour éviter que les deux extensions ne soient actives en même temps.

## Démarrer en développement

1. Ouvrir ce dossier dans VS Code.
2. Appuyer sur **F5** pour démarrer une fenêtre de développement de l'extension.
3. Dans cette fenêtre, ouvrir un fichier MIPS, par exemple `examples/pointers.s`.
4. Exécuter **MIPS Runner: Load Active File** depuis la palette de commandes, ou utiliser le bouton de lecture dans l'éditeur.
5. Le panneau **MIPS Runner** s'ouvre en bas de VS Code. Utiliser **Step** ou **Run** pour exécuter le programme.

Le contenu actuel de l'éditeur est utilisé, y compris les modifications non enregistrées. Après une modification, cliquer sur **Assemble** pour appliquer la nouvelle version ; l'exécution est suspendue jusqu'à cette réinitialisation.

Les fichiers `.s`, `.asm` et `.mips` utilisent la coloration syntaxique MIPS. Si une autre extension prend en charge le même type de fichier, sélectionner **MIPS** dans le sélecteur de langage en bas à droite de l'éditeur.

Quand un fichier MIPS devient actif, l’extension propose par défaut de le charger. Le réglage **MIPS Runner: Open Behavior** permet de choisir `ask` (proposer), `auto` (charger automatiquement) ou `manual` (utiliser la commande manuelle). Une proposition ignorée ne réapparaît pas tant que le fichier reste ouvert. Le fichier déjà chargé n’est pas réinitialisé lorsqu’on revient sur son onglet.

## Utilisation

- Les registres et les segments **data** et **stack** restent visibles ensemble. Cliquer sur la valeur d'un registre contenant une adresse de ces segments pour suivre cette adresse.
- Les formulaires **Address** acceptent une adresse hexadécimale et affichent les mots de 32 bits à partir de l'adresse alignée correspondante. **Follow $sp** reprend le suivi du pointeur de pile.
- Les valeurs modifiées sont mises en évidence après un pas. Pendant **Run**, l'affichage est actualisé par lots d'instructions.
- La prochaine instruction à exécuter est surlignée dans l'éditeur, avec une flèche dans la marge. Le surlignage disparaît si le code change ou lorsque le programme est terminé. Un pas exécute une instruction machine : une pseudo-instruction peut donc rester surlignée pendant plusieurs pas. Lors de l'assemblage, la routine de démarrage SPIM habituelle est exécutée jusqu'à `main` avant le premier pas.
- Au survol d’une instruction courante, une infobulle explique son rôle et son format d’opérandes. Elle propose aussi un lien vers le manuel SPIM. Les noms d’opérandes de l’infobulle sont des exemples de paramètres, pas des noms de registres à saisir.
- Pendant la saisie, SPIM vérifie la syntaxe du fichier MIPS et affiche ses erreurs dans l’éditeur et dans **Problems**. Cette vérification ne modifie pas l’état de l’exécution en cours et ne nécessite pas d’ouvrir le panneau du simulateur.
- La section **Instructions and breakpoints** affiche les instructions assemblées avec leurs adresses. Cliquer sur une instruction pour activer ou retirer un point d'arrêt. **Reset** et **Assemble** retirent les points d'arrêt et redémarrent l'exécution.
- Pour un programme qui lit l'entrée standard, saisir les lignes dans **Standard input**, puis cliquer sur **Reset** ou **Assemble** avant l'exécution. La sortie et les messages du simulateur apparaissent dans **Output and SPIM log**.

## Limites actuelles

- Il s'agit d'une première version pour VS Code sur ordinateur. La version web de VS Code n'est pas encore prise en charge.
- Les infobulles couvrent les instructions MIPS et pseudo-instructions courantes, pas encore toutes les instructions SPIM. Le validateur utilise l’assembleur SPIM : il signale généralement la première erreur de syntaxe, mais ne vérifie pas tous les problèmes d’exécution ni les étiquettes non définies.
- Les points d'arrêt se trouvent dans la liste d'instructions de MIPS Runner. Ils ne sont pas encore synchronisés avec ceux de l'éditeur VS Code.
- L'entrée standard est préparée à l'avance ; la saisie interactive en cours d'exécution n'est pas encore prise en charge.
- Le runtime utilise un système de fichiers virtuel distinct des fichiers du projet. Les appels système sur des fichiers n'accèdent pas directement au dossier VS Code.
- Le moteur SPIM actuel n'expose qu'une vue limitée de la pile. Si cette dernière grandit au-delà de cette vue, l'extension masque les valeurs de pile et affiche un avertissement plutôt que des données potentiellement incorrectes.
- Les adresses associées aux registres sont proposées comme pointeurs lorsqu'elles appartiennent à un segment affichable : une valeur numérique peut correspondre à une adresse sans être un pointeur intentionnel.

## Moteur et provenance

Le répertoire `vendor/spim` contient les fichiers WebAssembly et le code source SPIM provenant du dépôt local JsSpim, révision `64ddfacb70ccd5a63469d34a76eda109d5a820d2`. Les fichiers générés sont inclus afin que l'extension fonctionne sans compilation préalable ni dépendance à un dépôt voisin. Les informations de licence sont reprises dans [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Le projet n'a pas encore de licence propre. L'identifiant de l'extension est `Jisko.mips-runner`.
