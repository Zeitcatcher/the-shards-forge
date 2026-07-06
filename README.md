# The Shards Forge

Custom Pathfinder 2e (Remaster) content for the homebrew world The Shards, packaged as Foundry VTT compendium packs. Everything the Shards toolkit builds lands here: NPCs, magic items, spells, and reusable abilities. Nothing has to be imported by hand.

## Install

In Foundry, open Add-on Modules, choose Install Module, and paste this Manifest URL:

```
https://github.com/Zeitcatcher/the-shards-forge/releases/latest/download/module.json
```

Enable it in your world. It needs the pf2e system. New content ships as GitHub releases, so click Update on the module to pull it.

## What's inside

One folder in the Compendium tab, named The Shards Forge:

| Pack | Contents |
|---|---|
| Shards Items | Custom magic items, such as Whisper of the Wind. |
| Shards Abilities | Standalone reusable actions and effects. |
| Shards Actors | The world's NPCs and creatures. Added as content lands. |
| Shards Spells | Custom spells. Added as content lands. |

Standard Pathfinder items and spells are not copied here. They stay in the pf2e system compendia, and this module holds only custom content. NPCs embed their gear the way every Foundry actor does.

## Building it

Source lives as readable JSON in `src/`. A GitHub Action compiles it into LevelDB packs with the official Foundry CLI and publishes a release. To build locally:

```
npm install
npm run build
```

## Notice

This module uses trademarks and copyrights owned by Paizo Inc., used under Paizo's Community Use Policy (paizo.com/community/communityuse). You may not be charged to use or access this content. This module is not published, endorsed, or specifically approved by Paizo Inc. For more about Paizo Inc. and Paizo products, visit paizo.com.

## License

Code and configuration are under [PolyForm Noncommercial 1.0.0](./LICENSE). Pathfinder game content belongs to Paizo, used under the Community Use Policy above.
