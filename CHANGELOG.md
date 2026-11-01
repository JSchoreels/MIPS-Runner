# Historique des versions

## 0.0.11

**User facing changes**

- Découvrez l'exécution pas à pas et le suivi des pointeurs dans deux animations sur la page de l'extension.
- Les commandes **Run** et **Step** de MIPS Runner activent le débogueur VS Code pour rendre les registres disponibles dans **Watch** pendant les pauses.
- Le fichier MIPS actif est chargé automatiquement par défaut. **Run**, **Step** et **Reset** assemblent les modifications de l'éditeur à la demande ; les boutons de chargement et d'assemblage disparaissent du panneau.
- Retrouvez pour chaque registre et mot mémoire la dernière ligne ayant changé sa valeur. Cliquer sur un registre ou une adresse mémoire met en évidence ses références et sa dernière modification dans l'éditeur.

**Technical details**

- La session de débogage reprend l'état déjà chargé lorsque le code n'a pas changé ; après une modification, elle redémarre sur la version courante et conserve les points d'arrêt. L'historique reflète les changements réels et est effacé à chaque assemblage.
- Les animations montrent la vue MIPS Runner et le simulateur SPIM avec un aperçu dédié du code source.

## 0.0.10

Cette version regroupe les nouveautés depuis la version 0.0.3 du Marketplace.

**User facing changes**

- Lancez et déboguez le fichier MIPS actif avec les commandes natives de VS Code et placez les points d'arrêt dans la marge de l'éditeur. **Run Without Debugging** exécute le programme sans s'arrêter aux points d'arrêt.
- Explorez une carte reliant les registres aux segments data et stack ; cliquez sur un registre ou une étiquette de données dans l'éditeur pour suivre les adresses et pointeurs possibles.
- Retrouvez les registres dans une liste compacte, filtrable selon leur présence dans le code ou leur utilisation à l'exécution. Les valeurs des registres et de la mémoire affichent l'hexadécimal et le décimal signé ensemble.
- Évaluez un registre ou `PC` dans **Watch** pendant une pause. Les commandes et points d'arrêt de VS Code remplacent la liste d'instructions du panneau MIPS Runner.
- Déplacez MIPS Runner entre le panneau inférieur et la barre latérale secondaire en conservant l'exécution en cours.

**Technical details**

- Le débogueur et la carte mémoire utilisent le même simulateur SPIM. Le moteur enregistre les lectures et écritures des registres, y compris pendant les appels système ; les chemins de pointeurs sont des interprétations possibles des valeurs mémoire.
- La prise en charge des expressions Watch se limite aux noms ou numéros de registres et à `PC`. Les points d'arrêt conditionnels, les logpoints et **Step Out** ne sont pas encore pris en charge.
- Vérifications : contrôles JavaScript, scénarios SPIM et essais de l'interface et du débogage natif dans VS Code.

## 0.0.9

**User facing changes**

- Lancez le fichier MIPS actif avec **Run Without Debugging** sans assemblage manuel ; l'exécution ignore les points d'arrêt et la sortie apparaît dans la console de VS Code et dans MIPS Runner.

**Technical details**

- Le mode sans débogage ignore les points d'arrêt pendant son exécution sans les supprimer. Les prochaines exécutions avec débogage les respectent à nouveau.
- Vérifications : contrôles JavaScript, essais des commandes natives d'exécution et de débogage dans VS Code, et vérification de la conservation des points d'arrêt.

## 0.0.8

**User facing changes**

- Lancez MIPS Runner depuis **Run and Debug** et placez vos points d'arrêt directement dans la marge de VS Code. Le panneau mémoire et le débogueur suivent la même exécution.
- Les points d'arrêt sont partagés avec la liste d'instructions de MIPS Runner et restent en place après **Reset** ou **Assemble**.

**Technical details**

- L'adaptateur de débogage utilise le simulateur SPIM existant et expose les registres à VS Code. **Step Over** et **Step Into** avancent d'une instruction machine ; **Step Out**, « Run Without Debugging », les points d'arrêt conditionnels et les logpoints ne sont pas encore pris en charge.
- Vérifications : contrôles JavaScript et essais du débogage natif, des points d'arrêt et de la carte mémoire dans VS Code.

## 0.0.7

**User facing changes**

- Cliquer sur un registre dans l'éditeur le met en évidence dans la liste et affiche les liens mémoire possibles, comme une sélection dans MIPS Runner.

**Technical details**

- Les registres généraux sont reconnus par leur nom ou leur numéro, y compris les alias SPIM. La liste défile vers le registre sélectionné sans déplacer le focus de l'éditeur.
- Vérifications : contrôles JavaScript, scénarios SPIM de sélection des registres et essai dans VS Code avec conservation de l'exécution et du point d'arrêt.

## 0.0.6

**User facing changes**

- Cliquer sur une étiquette de données dans le fichier chargé met en évidence son adresse dans la carte mémoire et affiche les pointeurs possibles, sans interrompre le programme. La sélection fonctionne à la définition et aux utilisations de l'étiquette.

**Technical details**

- Les adresses sont résolues par un assemblage SPIM séparé, sans modifier la mémoire ou l'état du simulateur en cours. Après une modification du fichier, un nouvel assemblage est nécessaire.
- Vérifications : contrôles JavaScript, scénarios SPIM de résolution des étiquettes et de liens mémoire, et test de la sélection dans VS Code avec conservation du point d'arrêt.

## 0.0.5

**User facing changes**

- Explorez une carte mémoire qui relie les registres aux cases des segments data et stack. Sélectionnez une adresse pour suivre les pointeurs possibles, même lorsque leur destination n'est pas visible dans la liste.
- Repérez les cycles et les adresses non alignées dans le chemin ; naviguez vers une adresse du chemin ou suivez un pointeur depuis une case mémoire.

**Technical details**

- Les chemins sont calculés à partir de l'état courant du simulateur, limités à huit cases et présentés comme des interprétations possibles des valeurs. Les noms de symboles ne sont pas exposés par le moteur SPIM intégré.
- Vérifications : contrôles JavaScript, scénarios SPIM de liens entre data et stack, de cycles et d'adresses non alignées, et essai de la vue dans VS Code.

## 0.0.4

**User facing changes**

- Déplacez MIPS Runner entre le panneau inférieur et la barre latérale droite en conservant l'exécution, les registres, les points d'arrêt et l'entrée standard.
- Les registres et la mémoire s'adaptent aux panneaux étroits. Les lignes de la liste d'instructions ne sont plus coupées et affichent l'adresse et la ligne du fichier source.

**Technical details**

- Le moteur SPIM s'exécute dans un worker conservé lors de la recréation de la vue VS Code. Les pseudo-instructions restent associées à chaque adresse machine correspondante.
- Vérifications : contrôles JavaScript, exécution et entrées-sorties SPIM, et test dans VS Code du déplacement de la vue avec un programme en pause et un point d'arrêt.

## 0.0.3

**User facing changes**

- MIPS Runner utilise désormais l'identifiant officiel `Jisko.mips-runner` pour sa distribution sur GitHub et le Marketplace VS Code.
- Si la version de développement `local.mips-runner` est déjà installée, désinstallez-la avant d'installer cette version pour éviter d'activer deux extensions identiques.

**Technical details**

- Le manifeste référence le dépôt GitHub et le publisher Jisko ; les fonctionnalités et la compatibilité avec VS Code 1.85 ou ultérieur restent inchangées.
- Vérifications : contrôles JavaScript, tests du chargement et de l'exécution SPIM, installation du VSIX dans un profil isolé et test des infobulles et du validateur dans VS Code.

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
