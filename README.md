# RunDraw

Dessine une forme à main levée sur une carte, RunDraw calcule un parcours de course
qui la reproduit **en suivant les rues** (données OpenStreetMap) et l'exporte en **GPX**.

## Utilisation

1. Déplace / zoome la carte : le carré orange définit la zone (max 6 km de côté).
2. Dessine dans le carré (ou choisis une forme : cœur, étoile, cercle, smiley).
3. « Générer le parcours » → le tracé orange suit les rues, le bleu est ton dessin.
4. « Télécharger le GPX » → à importer dans Strava, Garmin Connect, Komoot, etc.

Options :
- **Ajuster automatiquement** : essaie de petites rotations / mises à l'échelle / décalages
  du dessin pour qu'il colle mieux au réseau local.
- **Relier les traits** : un dessin en plusieurs traits devient un seul parcours
  (les liaisons apparaissent en pointillés). Sinon, un segment GPX par trait.
- **Fidélité au dessin** : plus haut = colle plus au dessin quitte à faire des détours.

## Lancer en local

Aucune dépendance, aucun build : c'est un site statique.

```bash
python3 -m http.server 8000
```

puis ouvre http://localhost:8000. Fonctionne aussi tel quel sur GitHub Pages.

Test de l'algorithme sur un réseau synthétique :

```bash
node test/synthetic.mjs
```

## Comment ça marche

- `src/graph.js` : télécharge les voies praticables à pied via l'API Overpass
  (exclut autoroutes, voies privées, `foot=no`), construit un graphe et ne garde que
  la plus grande composante connexe. Index spatial en grille.
- `src/router.js` : le trait est rééchantillonné, des points de passage sont placés
  (coins + pas régulier) et accrochés au nœud le plus proche. Entre deux points, A*
  avec un coût `longueur × (1 + K·(écart au dessin / tolérance)²)` : le chemin préfère
  les rues qui longent le dessin plutôt que le plus court. Les petits allers-retours
  dus à l'accrochage sont supprimés.
- `src/gpx.js` : export GPX 1.1. `src/shapes.js` : formes prédéfinies.

## Limites connues (prototype)

- Calcul dans le fil principal du navigateur (OK jusqu'à quelques km²).
- Dépend des serveurs publics Overpass / Nominatim (limites d'usage).
- Pas encore de distance cible, ni de choix du point de départ.
