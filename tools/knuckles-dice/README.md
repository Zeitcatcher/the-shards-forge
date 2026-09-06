# Knuckles Game dice (snapshot)

Read-only copy of the 37 dice items shipped by the **Knuckles Game** module
(`knuckles-game` 1.5.1, `src/packs/dice/`). The Forge never edits these and the Knuckles
module is not touched: an NPC recipe that carries
`flags["knuckles-game"].defaultLoadout` (six catalog ids) gets one copy of each listed die
embedded in its inventory at build time, so the actor already owns its hand when a game
starts in physical mode (Knuckles clamps an unowned default to honest dice otherwise).
Identity is the die's `flags["knuckles-game"].dieId` plus the `knuckles-die-NN` slug, the
contract Knuckles documents; its restampers rename and reprice these copies to the table's
theme at load, so the neutral English names here never reach the sheet.

Refresh by copying the files again after a Knuckles release that changes them.
